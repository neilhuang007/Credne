// Package broker embeds the CLIProxyAPI SDK as a private, shared account
// broker for the harness. One broker per user home serves every harness
// process over loopback HTTP with a per-run bearer token.
//
// The broker owns credentials (OAuth login, storage, refresh), account state
// (cooldowns, quota, disable) and request execution against the selected
// account. Harness processes own sessions, prompts, tools and policies, and
// address accounts explicitly:
//
//	/credne/v1/route/a.<base64url auth id>/...  pinned account, never falls back
//	/credne/v1/route/p.<provider>/...           CLIProxyAPI pool selection
package broker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"time"

	"github.com/gin-gonic/gin"
	sdkapi "github.com/router-for-me/CLIProxyAPI/v8/sdk/api"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	log "github.com/sirupsen/logrus"
)

// Options configures one broker run.
type Options struct {
	// Home holds credentials (auths/), the optional user config.yaml, the
	// generated runtime config and the discovery file.
	Home string
	// IdleTimeout stops the broker after this long without API requests.
	// Zero keeps it running until stopped.
	IdleTimeout time.Duration
	// MaxConcurrentPerAccount bounds in-flight requests per pinned account.
	// Zero means unlimited.
	MaxConcurrentPerAccount int
	// Version is reported in health and discovery records.
	Version string
	// OnReady, when set, is called once the broker is serving and its
	// discovery record is written.
	OnReady func(State)
	// AnthropicBaseURL overrides the official Anthropic API endpoint used by
	// API-key and API-credit accounts. Empty means https://api.anthropic.com.
	AnthropicBaseURL string
	// OpenAIBaseURL overrides the official OpenAI API endpoint for API keys.
	OpenAIBaseURL string
}

// Run starts the broker and blocks until ctx is cancelled, the broker is shut
// down over IPC, or it becomes idle. It returns ErrAlreadyRunning when another
// broker serves the same home directory.
func Run(ctx context.Context, opts Options) error {
	home, err := filepath.Abs(opts.Home)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Join(home, "auths"), 0o700); err != nil {
		return err
	}
	lock, err := acquireLock(filepath.Join(home, "broker.lock"))
	if err != nil {
		return err
	}
	defer lock.release()

	token, err := randomToken()
	if err != nil {
		return err
	}
	lockedSecret, err := randomToken()
	if err != nil {
		return err
	}
	port, err := freeLoopbackPort()
	if err != nil {
		return err
	}
	cfg, runtimePath, err := buildRuntimeConfig(home, port, lockedSecret)
	if err != nil {
		return err
	}

	runCtx, stop := context.WithCancel(ctx)
	defer stop()
	anthropicBaseURL := opts.AnthropicBaseURL
	if anthropicBaseURL == "" {
		anthropicBaseURL = anthropicDefaultBaseURL
	}
	srv := &server{
		token:       token,
		host:        fmt.Sprintf("127.0.0.1:%d", port),
		gate:        newGate(token, port),
		limiter:     newAccountLimiter(opts.MaxConcurrentPerAccount),
		sessions:    newPoolSessions(),
		apiAccounts: newAPIAccounts(home, anthropicBaseURL, newAntTool(home)),
		baselines:   newLoginBaselines(),
		stop:        stop,
	}
	if opts.OpenAIBaseURL != "" {
		srv.apiAccounts.openAIBaseURL = opts.OpenAIBaseURL
	}
	state := State{
		Schema:          stateSchema,
		PID:             os.Getpid(),
		URL:             "http://" + srv.host,
		Token:           token,
		BrokerVersion:   opts.Version,
		UpstreamVersion: upstreamVersion(),
		StartedAt:       time.Now().UTC(),
	}
	srv.state = state

	svc, err := cliproxy.NewBuilder().
		WithConfig(cfg).
		WithConfigPath(runtimePath).
		WithLocalManagementPassword(token).
		WithHooks(cliproxy.Hooks{
			OnConfigApplied: func(_ *cliproxy.Service, _ *config.Config) {
				// Config reloads replace custom executors with generic OpenAI compatibility executors.
				srv.registerAPIExecutors()
			},
		}).
		WithServerOptions(
			sdkapi.WithMiddleware(srv.gate.handle),
			sdkapi.WithRouterConfigurator(srv.configure),
		).
		Build()
	if err != nil {
		return fmt.Errorf("build CLIProxyAPI service: %w", err)
	}

	runErr := make(chan error, 1)
	go func() { runErr <- svc.Run(runCtx) }()

	if err = waitHealthy(runCtx, state, runErr); err != nil {
		stop()
		<-runErr
		return err
	}
	if err = srv.apiAccounts.load(runCtx, srv.handler.AuthManager); err != nil {
		log.Warnf("load API accounts: %v", err)
	}
	if err = writeState(home, state); err != nil {
		stop()
		<-runErr
		return err
	}
	defer removeState(home, state)
	log.Infof("broker ready at %s (CLIProxyAPI %s)", state.URL, state.UpstreamVersion)
	go srv.gate.watchIdle(runCtx, opts.IdleTimeout, stop)
	if opts.OnReady != nil {
		opts.OnReady(state)
	}

	err = <-runErr
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

// server holds the broker routes and the CLIProxyAPI handles they use.
type server struct {
	token       string
	host        string
	state       State
	gate        *gate
	limiter     *accountLimiter
	sessions    *poolSessions
	apiAccounts *apiAccounts
	baselines   *loginBaselines
	stop        func()
	engine      *gin.Engine
	handler     *handlers.BaseAPIHandler
}

// configure registers the broker API after CLIProxyAPI's default routes. The
// gate makes those default routes unreachable.
func (s *server) configure(engine *gin.Engine, handler *handlers.BaseAPIHandler, _ *config.Config) {
	s.engine = engine
	s.handler = handler
	s.registerAPIExecutors()
	api := engine.Group(APIPrefix[:len(APIPrefix)-1])
	api.GET("/health", s.health)
	api.POST("/shutdown", s.shutdown)
	api.GET("/accounts", s.listAccounts)
	api.GET("/accounts/:key/models", s.accountModels)
	api.GET("/accounts/:key/usage", s.accountUsage)
	api.POST("/accounts/:key/disable", s.setDisabled(true))
	api.POST("/accounts/:key/enable", s.setDisabled(false))
	api.POST("/accounts/:key/reset", s.resetCooldown)
	api.DELETE("/accounts/:key", s.deleteAccount)
	api.POST("/api-keys", s.addAPIKey)
	api.POST("/logins", s.startLogin)
	api.GET("/logins/:state", s.loginStatus)
	api.POST("/logins/:state/callback", s.loginCallback)
	api.DELETE("/logins/:state", s.cancelLogin)
	// One base URL per target serves every protocol, so a pool can mix models
	// that use different APIs: SDKs append /v1/messages, /responses or
	// /chat/completions to it.
	api.POST("/route/:target/v1/messages", s.execute(protocolClaude))
	api.POST("/route/:target/responses", s.execute(protocolOpenAIResponses))
	api.POST("/route/:target/chat/completions", s.execute(protocolOpenAIChat))
	// Decisions is not a chat protocol: the body goes to OpenAI's /v1/decisions as sent, so only
	// OpenAI API-key accounts and pool openai serve it.
	api.POST("/route/:target/decisions", s.decisions)
}

// registerAPIExecutors binds broker-managed accounts to their official API handlers.
func (s *server) registerAPIExecutors() {
	s.handler.AuthManager.RegisterExecutor(s.apiAccounts.executor())
	s.handler.AuthManager.RegisterExecutor(&openaiExecutor{baseURL: s.apiAccounts.openAIBaseURL, client: &http.Client{}})
}

func (s *server) health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"ok":              true,
		"pid":             s.state.PID,
		"brokerVersion":   s.state.BrokerVersion,
		"upstreamVersion": s.state.UpstreamVersion,
		"startedAt":       s.state.StartedAt,
		"accounts":        len(s.handler.AuthManager.List()),
	})
}

func (s *server) shutdown(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true})
	c.Writer.Flush()
	go s.stop()
}

// waitHealthy polls the broker's own health route until it answers, the
// service exits, or a startup deadline passes.
func waitHealthy(ctx context.Context, state State, runErr <-chan error) error {
	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-runErr:
			if err == nil {
				err = errors.New("service stopped during startup")
			}
			return fmt.Errorf("start CLIProxyAPI service: %w", err)
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, state.URL+APIPrefix+"health", nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+state.Token)
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			return nil
		}
	}
	return errors.New("broker did not become healthy within 15s")
}

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "cbk_" + hex.EncodeToString(buf), nil
}

// freeLoopbackPort asks the OS for an unused loopback port. CLIProxyAPI binds
// by address, so the port is released here and rebound immediately after.
func freeLoopbackPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer func() { _ = listener.Close() }()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

func upstreamVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	for _, dep := range info.Deps {
		if dep.Path == "github.com/router-for-me/CLIProxyAPI/v8" {
			if dep.Replace != nil {
				return dep.Replace.Version
			}
			return dep.Version
		}
	}
	return "unknown"
}
