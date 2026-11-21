// Serves OpenAI's Decisions API for OpenAI API-key accounts.
package broker

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

// The Decisions API (POST /v1/decisions) classifies a state with structured questions. It is not a
// chat protocol and CLIProxyAPI has no translator for it, so the route bypasses CLIProxyAPI's request
// execution: the body goes to OpenAI as sent and the answer comes back as OpenAI sent it, with the
// account's API key as the only credential. OpenAI rejects Sign in with ChatGPT tokens on this route,
// so a request that resolves to a subscription account is refused here instead of sent.
const (
	protocolOpenAIDecisions = "openai-decisions"
	decisionsUpstreamPath   = "/v1/decisions"
	// decisionsPool is the pool of OpenAI API keys, named as in execute.
	decisionsPool = "openai"
)

// decisionsResponseHeaders are the upstream headers the client sees: the body type and the hints it
// needs to retry or report a failure. Everything else, such as cookies, stays with the broker.
var decisionsResponseHeaders = []string{"Content-Type", "Retry-After", "X-Request-Id"}

// decisions serves one Decisions API request for a pinned OpenAI API-key account or for pool openai.
func (s *server) decisions(c *gin.Context) {
	target, err := parseTarget(c.Param("target"))
	if err != nil {
		writeError(c, protocolOpenAIDecisions, http.StatusBadRequest, err.Error(), nil)
		return
	}
	body, head, ok := readRequest(c, protocolOpenAIDecisions)
	if !ok {
		return
	}
	auth, label, ok := s.decisionsAccount(c, target, head.Model)
	if !ok {
		return
	}
	if target.authID != "" {
		release, errAcquire := s.limiter.acquire(c.Request.Context(), target.authID)
		if errAcquire != nil {
			return
		}
		defer release()
	}
	s.forwardDecisions(c, auth, label, body)
}

// decisionsAccount resolves the OpenAI API-key account that serves a request, with the label that
// error messages use for it. A target that cannot serve the Decisions API is answered to the client
// and reported as false.
func (s *server) decisionsAccount(c *gin.Context, target routeTarget, model string) (*coreauth.Auth, string, bool) {
	if target.authID != "" {
		auth, label, ok := s.pinnedAccount(c, protocolOpenAIDecisions, target.authID)
		if !ok {
			return nil, "", false
		}
		if !isOpenAIAPIKey(auth) {
			writeError(c, protocolOpenAIDecisions, http.StatusBadRequest,
				label+" is not an OpenAI API-key account; the Decisions API accepts OpenAI API keys only", nil)
			return nil, "", false
		}
		return auth, label, true
	}
	label := "pool " + target.pool
	if target.pool != decisionsPool {
		writeError(c, protocolOpenAIDecisions, http.StatusBadRequest,
			label+" cannot serve the Decisions API; use pool "+decisionsPool+" or a pinned OpenAI API-key account", nil)
		return nil, "", false
	}
	// The pool uses CLIProxyAPI's own selection: cooling and disabled accounts are skipped, and only
	// accounts whose model list has the requested model are candidates.
	auth, err := s.handler.AuthManager.SelectAuth(c.Request.Context(), OpenAIAPIProviderKey, model, cliproxyexecutor.Options{})
	if err != nil {
		writeSelectionError(c, label, model, err)
		return nil, "", false
	}
	return auth, label, true
}

// isOpenAIAPIKey reports whether auth is a broker-managed OpenAI API key, the only credential the
// Decisions API accepts.
func isOpenAIAPIKey(auth *coreauth.Auth) bool {
	return strings.EqualFold(auth.Provider, OpenAIAPIProviderKey) && auth.Attributes[attrKind] == kindAPIKey
}

// writeSelectionError answers a failed pool selection: no account serves the model, or every account
// that does is cooling down.
func writeSelectionError(c *gin.Context, label, model string, err error) {
	var authErr *coreauth.Error
	if errors.As(err, &authErr) && authErr.Code == "auth_not_found" {
		writeError(c, protocolOpenAIDecisions, http.StatusServiceUnavailable,
			fmt.Sprintf("%s: no enabled OpenAI API-key account serves %s", label, model), nil)
		return
	}
	failure := handlers.ExecutionErrorMessage(err)
	status := failure.StatusCode
	// A selection failure that is retryable carries its own status; a bare one means unavailable.
	if status == http.StatusInternalServerError {
		status = http.StatusServiceUnavailable
	}
	writeExecutionError(c, protocolOpenAIDecisions, label, status, failure.Error, failure.Addon)
}

// forwardDecisions sends body to OpenAI with the account's API key and returns OpenAI's status and
// body unchanged, including its errors. The executor registered for the account adds the key.
func (s *server) forwardDecisions(c *gin.Context, auth *coreauth.Auth, label string, body []byte) {
	ctx := c.Request.Context()
	url := strings.TrimRight(s.apiAccounts.openAIBaseURL, "/") + decisionsUpstreamPath
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		writeError(c, protocolOpenAIDecisions, http.StatusInternalServerError, label+": "+err.Error(), nil)
		return
	}
	for name, values := range forwardHeaders(c.Request.Header) {
		req.Header[name] = values
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.handler.AuthManager.HttpRequest(ctx, auth, req)
	if err != nil {
		writeError(c, protocolOpenAIDecisions, http.StatusBadGateway, label+": "+err.Error(), nil)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	header := c.Writer.Header()
	for _, name := range decisionsResponseHeaders {
		if values := resp.Header.Values(name); len(values) > 0 {
			header[name] = append([]string(nil), values...)
		}
	}
	header.Set(AccountHeader, encodeKey(auth.ID))
	c.Writer.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(c.Writer, resp.Body)
}
