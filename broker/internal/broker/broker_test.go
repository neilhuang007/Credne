package broker

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	log "github.com/sirupsen/logrus"
)

// fakeUpstream stands in for api.anthropic.com and api.openai.com. Each API
// key gets a scripted behavior; every request records the key it carried.
type fakeUpstream struct {
	mu             sync.Mutex
	calls          map[string]int
	failKeys       map[string]int // key -> HTTP status to return
	rejectThinking map[string]bool
	bodies         []string
	lastBody       map[string]string
	lastHeader     map[string]http.Header
	hang           chan struct{} // closed when a hanging request observes cancellation
	server         *httptest.Server
}

func newFakeUpstream() *fakeUpstream {
	f := &fakeUpstream{
		calls:          map[string]int{},
		failKeys:       map[string]int{},
		rejectThinking: map[string]bool{},
		lastBody:       map[string]string{},
		lastHeader:     map[string]http.Header{},
		hang:           make(chan struct{}),
	}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	return f
}

func (f *fakeUpstream) last(key string) (string, http.Header) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastBody[key], f.lastHeader[key]
}

func (f *fakeUpstream) key(r *http.Request) string {
	if key := r.Header.Get("X-Api-Key"); key != "" {
		return key
	}
	return strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
}

func (f *fakeUpstream) count(key string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[key]
}

func (f *fakeUpstream) setFail(key string, status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if status == 0 {
		delete(f.failKeys, key)
		return
	}
	f.failKeys[key] = status
}

func (f *fakeUpstream) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	key := f.key(r)
	if r.Method == http.MethodGet && r.URL.Path == "/v1/models" {
		if strings.HasPrefix(key, "sk-openai-") {
			_, _ = w.Write([]byte(`{"data":[{"id":"gpt-6-luna"},{"id":"gpt-image-1"}]}`))
			return
		}
		if !strings.HasPrefix(key, "sk-ant-api") && !strings.HasPrefix(key, "sk-ant-oat01-fake-") {
			http.Error(w, `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`, http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"claude-api-test","display_name":"Claude API Test","type":"model"}],"has_more":false}`))
		return
	}
	f.mu.Lock()
	f.calls[key]++
	f.bodies = append(f.bodies, string(body))
	f.lastBody[key] = string(body)
	f.lastHeader[key] = r.Header.Clone()
	status := f.failKeys[key]
	reject := f.rejectThinking[key] && strings.Contains(string(body), `"type":"thinking"`)
	f.mu.Unlock()

	if reject {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid ` + "`signature`" + ` in ` + "`thinking`" + ` block"}}`))
		return
	}
	if status != 0 {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(status)
		_, _ = fmt.Fprintf(w, `{"type":"error","error":{"type":"rate_limit_error","message":"key %s is rate limited"}}`, key)
		return
	}
	if r.URL.Path == "/v1/decisions" {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "req_fake")
		w.Header().Set("Set-Cookie", "__cf_bm=upstream-cookie")
		_, _ = fmt.Fprintf(w, `{"model":"gpt-6-luna","answers":[],"path":%q,"key":%q}`, r.URL.Path, key)
		return
	}
	if strings.Contains(string(body), "HANG") {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(f.hang)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	if strings.HasSuffix(r.URL.Path, "/v1/messages") {
		writeSSE(w, anthropicStream("hello from "+key))
		return
	}
	writeSSE(w, responsesStream("hello from "+key))
}

func writeSSE(w http.ResponseWriter, events [][2]string) {
	for _, event := range events {
		_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event[0], event[1])
		w.(http.Flusher).Flush()
	}
}

func anthropicStream(text string) [][2]string {
	return [][2]string{
		{"message_start", `{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-test-1","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}`},
		{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`},
		{"content_block_delta", fmt.Sprintf(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":%q}}`, text)},
		{"content_block_stop", `{"type":"content_block_stop","index":0}`},
		{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}`},
		{"message_stop", `{"type":"message_stop"}`},
	}
}

func responsesStream(text string) [][2]string {
	item := fmt.Sprintf(`{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":%q,"annotations":[]}]}`, text)
	return [][2]string{
		{"response.created", `{"type":"response.created","response":{"id":"resp_1","object":"response","status":"in_progress","model":"gpt-test","output":[]}}`},
		{"response.output_item.added", `{"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","status":"in_progress","content":[]}}`},
		{"response.output_text.delta", fmt.Sprintf(`{"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":%q}`, text)},
		{"response.output_item.done", `{"type":"response.output_item.done","output_index":0,"item":` + item + `}`},
		{"response.completed", `{"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-test","output":[` + item + `],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}`},
	}
}

type testBroker struct {
	state    State
	upstream *fakeUpstream
	stop     context.CancelFunc
	done     chan error
	home     string
}

func startTestBroker(t *testing.T) *testBroker {
	t.Helper()
	gin.SetMode(gin.TestMode)
	log.SetLevel(log.WarnLevel)
	upstream := newFakeUpstream()
	home := t.TempDir()
	userConfig := fmt.Sprintf(`
routing:
  retry:
    request-retry: 0
api-keys:
  claude:
    - name: work
      base-url: %[1]s
      models:
        - name: claude-test-1
      keys:
        - api-key: sk-ant-A
    - name: personal
      base-url: %[1]s
      models:
        - name: claude-test-1
      keys:
        - api-key: sk-ant-B
  codex:
    - name: codex-key
      base-url: %[1]s
      models:
        - name: gpt-test
      keys:
        - api-key: sk-codex-C
`, upstream.server.URL)
	if err := os.WriteFile(filepath.Join(home, UserConfigFileName), []byte(userConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CREDNE_ANT", buildFakeAnt(t))
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan State, 1)
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, Options{
			Home:             home,
			Version:          "test",
			AnthropicBaseURL: upstream.server.URL,
			OpenAIBaseURL:    upstream.server.URL,
			OnReady:          func(s State) { ready <- s },
		})
	}()
	select {
	case state := <-ready:
		tb := &testBroker{state: state, upstream: upstream, stop: cancel, done: done, home: home}
		t.Cleanup(tb.close)
		return tb
	case err := <-done:
		cancel()
		t.Fatalf("broker exited during startup: %v", err)
	case <-time.After(30 * time.Second):
		cancel()
		t.Fatal("broker did not start")
	}
	return nil
}

// buildFakeAnt compiles testdata/fakeant, which imitates the ant commands the
// broker runs.
func buildFakeAnt(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), antBinaryName())
	cmd := exec.Command("go", "build", "-o", binary, "./testdata/fakeant")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake ant: %v\n%s", err, out)
	}
	return binary
}

func (tb *testBroker) close() {
	tb.stop()
	<-tb.done
	tb.upstream.server.Close()
}

func (tb *testBroker) request(t *testing.T, method, path, body string, headers map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, tb.state.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+tb.state.Token)
	req.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func readAll(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// accountsByKey maps each configured API key to its broker account, using the
// key the fake upstream records for a pinned request.
func (tb *testBroker) accounts(t *testing.T) []accountView {
	t.Helper()
	var out struct {
		Accounts []accountView `json:"accounts"`
	}
	resp := tb.request(t, http.MethodGet, APIPrefix+"accounts", "", nil)
	if err := json.Unmarshal([]byte(readAll(t, resp)), &out); err != nil {
		t.Fatal(err)
	}
	return out.Accounts
}

func (tb *testBroker) accountFor(t *testing.T, provider, apiKey string) accountView {
	t.Helper()
	for _, account := range tb.accounts(t) {
		if account.Provider != provider {
			continue
		}
		before := tb.upstream.count(apiKey)
		resp := tb.request(t, http.MethodPost, routePath("a."+account.Key, provider), probeBody(provider), nil)
		readAll(t, resp)
		if tb.upstream.count(apiKey) > before {
			return account
		}
	}
	t.Fatalf("no %s account uses key %s", provider, apiKey)
	return accountView{}
}

// resetCooldowns clears quota state left by a failure case so the next case
// starts from healthy accounts.
func (tb *testBroker) resetCooldowns(t *testing.T) {
	t.Helper()
	for _, account := range tb.accounts(t) {
		resp := tb.request(t, http.MethodPost, APIPrefix+"accounts/"+account.Key+"/reset", "", nil)
		if body := readAll(t, resp); resp.StatusCode != http.StatusOK {
			t.Fatalf("reset %s: status %d body %s", account.ID, resp.StatusCode, body)
		}
	}
}

func (tb *testBroker) account(t *testing.T, key string) accountView {
	t.Helper()
	for _, account := range tb.accounts(t) {
		if account.Key == key {
			return account
		}
	}
	t.Fatalf("account %s not listed", key)
	return accountView{}
}

func (tb *testBroker) accountByID(t *testing.T, id string) accountView {
	t.Helper()
	for _, account := range tb.accounts(t) {
		if account.ID == id {
			return account
		}
	}
	t.Fatalf("account %s not listed", id)
	return accountView{}
}

type startedLogin struct {
	State string `json:"state"`
	URL   string `json:"url"`
	Error string `json:"error"`
}

type loginStatus struct {
	Status  string      `json:"status"`
	Error   string      `json:"error"`
	Account accountView `json:"account"`
}

// startLogin posts to /logins and returns the HTTP status with the decoded body.
func (tb *testBroker) startLogin(t *testing.T, body string) (int, startedLogin) {
	t.Helper()
	resp := tb.request(t, http.MethodPost, APIPrefix+"logins", body, nil)
	text := readAll(t, resp)
	var login startedLogin
	if err := json.Unmarshal([]byte(text), &login); err != nil {
		t.Fatalf("login start: status %d body %s", resp.StatusCode, text)
	}
	return resp.StatusCode, login
}

func (tb *testBroker) startCreditsLogin(t *testing.T, name string) (int, startedLogin) {
	t.Helper()
	return tb.startLogin(t, `{"provider":"`+APICreditsLoginProvider+`","name":"`+name+`"}`)
}

// completeCreditsLogin sends the browser redirect to fakeant's callback and
// waits for the login to end, either as ok or as an error.
func (tb *testBroker) completeCreditsLogin(t *testing.T, login startedLogin) loginStatus {
	t.Helper()
	authorize, _ := url.Parse(login.URL)
	callback := authorize.Query().Get("redirect_uri") + "?code=test-code&state=x"
	resp := tb.request(t, http.MethodPost, APIPrefix+"logins/"+login.State+"/callback", `{"redirectUrl":"`+callback+`"}`, nil)
	if text := readAll(t, resp); resp.StatusCode != http.StatusOK {
		t.Fatalf("credits callback: status %d body %s", resp.StatusCode, text)
	}
	var status loginStatus
	deadline := time.Now().Add(15 * time.Second)
	for status.Status != "ok" && status.Status != "error" {
		if time.Now().After(deadline) {
			t.Fatalf("credits login did not finish: %+v", status)
		}
		time.Sleep(100 * time.Millisecond)
		status = loginStatus{}
		_ = json.Unmarshal([]byte(readAll(t, tb.request(t, http.MethodGet, APIPrefix+"logins/"+login.State, "", nil))), &status)
	}
	return status
}

// signInCredits adds an API-credits account and fails the test unless it works.
func (tb *testBroker) signInCredits(t *testing.T, name string) accountView {
	t.Helper()
	httpStatus, login := tb.startCreditsLogin(t, name)
	if httpStatus != http.StatusOK {
		t.Fatalf("start credits login %s: status %d %+v", name, httpStatus, login)
	}
	status := tb.completeCreditsLogin(t, login)
	if status.Status != "ok" {
		t.Fatalf("credits login %s failed: %s", name, status.Error)
	}
	return status.Account
}

// addAPIKey posts to /api-keys and returns the HTTP status with the error text.
func (tb *testBroker) addAPIKey(t *testing.T, name, key string) (int, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"provider": "claude", "name": name, "key": key})
	resp := tb.request(t, http.MethodPost, APIPrefix+"api-keys", string(body), nil)
	text := readAll(t, resp)
	var out struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal([]byte(text), &out)
	return resp.StatusCode, out.Error
}

// addOpenAIKey adds an OpenAI API key through /api-keys and fails the test unless it is accepted.
func (tb *testBroker) addOpenAIKey(t *testing.T, name, key string) accountView {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"provider": "openai", "name": name, "key": key})
	resp := tb.request(t, http.MethodPost, APIPrefix+"api-keys", string(body), nil)
	text := readAll(t, resp)
	var added struct {
		Account accountView `json:"account"`
	}
	if err := json.Unmarshal([]byte(text), &added); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("add OpenAI key %s: status %d body %s", name, resp.StatusCode, text)
	}
	return added.Account
}

// accountIDs lists every account id in the broker's listing order.
func (tb *testBroker) accountIDs(t *testing.T) string {
	t.Helper()
	var ids []string
	for _, account := range tb.accounts(t) {
		ids = append(ids, account.ID)
	}
	return strings.Join(ids, ",")
}

func routePath(target, provider string) string {
	if provider == "codex" {
		return APIPrefix + "route/" + target + "/responses"
	}
	return APIPrefix + "route/" + target + "/v1/messages"
}

func probeBody(provider string) string {
	if provider == "codex" {
		return `{"model":"gpt-test","stream":true,"input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}]}`
	}
	return `{"model":"claude-test-1","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`
}

func TestBroker(t *testing.T) {
	tb := startTestBroker(t)
	accountA := tb.accountFor(t, "claude", "sk-ant-A")
	accountB := tb.accountFor(t, "claude", "sk-ant-B")

	t.Run("discovery record is written and points at a loopback broker", func(t *testing.T) {
		state, err := readState(tb.home)
		if err != nil {
			t.Fatal(err)
		}
		if state.Token != tb.state.Token || !strings.HasPrefix(state.URL, "http://127.0.0.1:") {
			t.Fatalf("unexpected discovery record: %+v", state)
		}
	})

	t.Run("gate rejects missing tokens, upstream routes and foreign hosts", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodGet, tb.state.URL+APIPrefix+"health", nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		readAll(t, resp)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("missing token: status %d", resp.StatusCode)
		}
		for _, path := range []string{"/v1/models", "/v1/messages", "/v8/management/credentials", "/v0/management/config"} {
			if resp := tb.request(t, http.MethodGet, path, "", nil); resp.StatusCode != http.StatusNotFound {
				t.Fatalf("%s reachable with token: status %d", path, resp.StatusCode)
			}
		}
		req, _ = http.NewRequest(http.MethodGet, tb.state.URL+APIPrefix+"health", nil)
		req.Host = "attacker.example"
		req.Header.Set("Authorization", "Bearer "+tb.state.Token)
		resp, err = http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		readAll(t, resp)
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("foreign host: status %d", resp.StatusCode)
		}
	})

	t.Run("account listing exposes kinds but never secrets", func(t *testing.T) {
		body := readAll(t, tb.request(t, http.MethodGet, APIPrefix+"accounts", "", nil))
		for _, secret := range []string{"sk-ant-A", "sk-ant-B", "sk-codex-C"} {
			if strings.Contains(body, secret) {
				t.Fatalf("account listing leaks %s", secret)
			}
		}
		for _, account := range tb.accounts(t) {
			if account.Kind != kindAPIKey || account.Source != "config" {
				t.Fatalf("config API-key account reported as %s/%s", account.Kind, account.Source)
			}
		}
	})

	t.Run("per-account model discovery", func(t *testing.T) {
		body := readAll(t, tb.request(t, http.MethodGet, APIPrefix+"accounts/"+accountA.Key+"/models", "", nil))
		if !strings.Contains(body, `"claude-test-1"`) {
			t.Fatalf("account models missing configured model: %s", body)
		}
	})

	t.Run("pinned stream is served only by the pinned account and passes through", func(t *testing.T) {
		beforeA, beforeB := tb.upstream.count("sk-ant-A"), tb.upstream.count("sk-ant-B")
		for range 3 {
			resp := tb.request(t, http.MethodPost, routePath("a."+accountB.Key, "claude"), probeBody("claude"), nil)
			body := readAll(t, resp)
			if resp.StatusCode != http.StatusOK || !strings.Contains(body, "hello from sk-ant-B") || !strings.Contains(body, "message_stop") {
				t.Fatalf("pinned stream: status %d body %s", resp.StatusCode, body)
			}
			if got := resp.Header.Get(AccountHeader); got != accountB.Key {
				t.Fatalf("account header %q, want %q", got, accountB.Key)
			}
		}
		if tb.upstream.count("sk-ant-A") != beforeA || tb.upstream.count("sk-ant-B") != beforeB+3 {
			t.Fatal("pinned requests reached another account")
		}
	})

	t.Run("pinned failure surfaces the error and never falls back", func(t *testing.T) {
		tb.upstream.setFail("sk-ant-B", http.StatusTooManyRequests)
		defer tb.upstream.setFail("sk-ant-B", 0)
		beforeA := tb.upstream.count("sk-ant-A")
		resp := tb.request(t, http.MethodPost, routePath("a."+accountB.Key, "claude"), probeBody("claude"), nil)
		body := readAll(t, resp)
		if resp.StatusCode != http.StatusTooManyRequests {
			t.Fatalf("pinned failure: status %d body %s", resp.StatusCode, body)
		}
		var envelope struct {
			Type  string `json:"type"`
			Error struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(body), &envelope); err != nil || envelope.Error.Type != "rate_limit_error" {
			t.Fatalf("error is not an Anthropic envelope: %s", body)
		}
		if resp.Header.Get("Retry-After") == "" {
			t.Fatal("Retry-After not forwarded")
		}
		if tb.upstream.count("sk-ant-A") != beforeA {
			t.Fatal("pinned failure fell back to another account")
		}
		if cooled := tb.account(t, accountB.Key); !cooled.QuotaExceeded || cooled.RetryAfter == nil {
			t.Fatalf("failed account does not report its cooldown: %+v", cooled)
		}
		tb.upstream.setFail("sk-ant-B", 0)
		resp = tb.request(t, http.MethodPost, routePath("a."+accountB.Key, "claude"), probeBody("claude"), nil)
		if body := readAll(t, resp); resp.StatusCode != http.StatusTooManyRequests {
			t.Fatalf("cooling pinned account served a request: status %d body %s", resp.StatusCode, body)
		}
		if tb.upstream.count("sk-ant-A") != beforeA {
			t.Fatal("cooling pinned account fell back to another account")
		}
		tb.resetCooldowns(t)
		if reset := tb.account(t, accountB.Key); reset.QuotaExceeded || reset.RetryAfter != nil {
			t.Fatalf("reset did not clear the cooldown: %+v", reset)
		}
	})

	t.Run("pool fails over across accounts", func(t *testing.T) {
		tb.upstream.setFail("sk-ant-A", http.StatusTooManyRequests)
		defer tb.resetCooldowns(t)
		defer tb.upstream.setFail("sk-ant-A", 0)
		for range 2 {
			resp := tb.request(t, http.MethodPost, routePath("p.claude", "claude"), probeBody("claude"), map[string]string{"X-Session-Affinity": fmt.Sprint(time.Now().UnixNano())})
			body := readAll(t, resp)
			if resp.StatusCode != http.StatusOK || !strings.Contains(body, "hello from sk-ant-B") {
				t.Fatalf("pool request: status %d body %s", resp.StatusCode, body)
			}
			if got := resp.Header.Get(AccountHeader); got != accountB.Key {
				t.Fatalf("pool served by %q, want %q", got, accountB.Key)
			}
		}
	})

	t.Run("responses protocol reaches a Codex account natively", func(t *testing.T) {
		codex := tb.accountFor(t, "codex", "sk-codex-C")
		resp := tb.request(t, http.MethodPost, routePath("a."+codex.Key, "codex"), probeBody("codex"), nil)
		body := readAll(t, resp)
		if resp.StatusCode != http.StatusOK || !strings.Contains(body, "response.completed") || !strings.Contains(body, "hello from sk-codex-C") {
			t.Fatalf("codex stream: status %d body %s", resp.StatusCode, body)
		}
		assertSSEFramed(t, body)
	})

	t.Run("client cancellation stops the upstream request", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		body := `{"model":"claude-test-1","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"HANG"}]}`
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, tb.state.URL+routePath("a."+accountA.Key, "claude"), strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+tb.state.Token)
		req.Header.Set("Content-Type", "application/json")
		go func() {
			resp, err := http.DefaultClient.Do(req)
			if err == nil {
				_, _ = bufio.NewReader(resp.Body).ReadString('\n')
				_ = resp.Body.Close()
			}
		}()
		time.Sleep(500 * time.Millisecond)
		cancel()
		select {
		case <-tb.upstream.hang:
		case <-time.After(10 * time.Second):
			t.Fatal("upstream request was not cancelled")
		}
	})

	t.Run("unknown and disabled accounts are rejected", func(t *testing.T) {
		resp := tb.request(t, http.MethodPost, routePath("a."+encodeKey("missing.json"), "claude"), probeBody("claude"), nil)
		if body := readAll(t, resp); resp.StatusCode != http.StatusNotFound || !strings.Contains(body, "not_found_error") {
			t.Fatalf("missing account: status %d body %s", resp.StatusCode, body)
		}
		resp = tb.request(t, http.MethodPost, APIPrefix+"accounts/"+accountA.Key+"/disable", "", nil)
		if body := readAll(t, resp); resp.StatusCode != http.StatusConflict {
			t.Fatalf("disabling a config account: status %d body %s", resp.StatusCode, body)
		}
	})

	t.Run("login facade starts and cancels an OAuth session", func(t *testing.T) {
		resp := tb.request(t, http.MethodPost, APIPrefix+"logins", `{"provider":"codex"}`, nil)
		var login struct {
			State string `json:"state"`
			URL   string `json:"url"`
		}
		if err := json.Unmarshal([]byte(readAll(t, resp)), &login); err != nil || login.State == "" || !strings.HasPrefix(login.URL, "https://") {
			t.Fatalf("login start: status %d %+v", resp.StatusCode, login)
		}
		if body := readAll(t, tb.request(t, http.MethodGet, APIPrefix+"logins/"+login.State, "", nil)); !strings.Contains(body, `"wait"`) {
			t.Fatalf("login status: %s", body)
		}
		if resp := tb.request(t, http.MethodDelete, APIPrefix+"logins/"+login.State, "", nil); resp.StatusCode != http.StatusOK {
			t.Fatalf("login cancel: status %d", resp.StatusCode)
		}
	})

	t.Run("API-key accounts call the official API unchanged with x-api-key", func(t *testing.T) {
		resp := tb.request(t, http.MethodPost, APIPrefix+"api-keys", `{"provider":"claude","name":"Console Key","key":"sk-ant-api03-test"}`, nil)
		var added struct {
			Account accountView `json:"account"`
		}
		if err := json.Unmarshal([]byte(readAll(t, resp)), &added); err != nil || added.Account.Kind != kindAPIKey || added.Account.Provider != APIProviderKey {
			t.Fatalf("add API key: status %d account %+v", resp.StatusCode, added.Account)
		}
		if added.Account.ModelCount != 1 {
			t.Fatalf("models were not discovered from /v1/models: %+v", added.Account)
		}
		body := `{"model":"claude-api-test","stream":true,"max_tokens":64,"system":"be brief","messages":[{"role":"user","content":"hi"}]}`
		resp = tb.request(t, http.MethodPost, routePath("a."+added.Account.Key, "claude"), body, map[string]string{"Anthropic-Beta": "fine-grained-tool-streaming-2025-05-14"})
		if text := readAll(t, resp); resp.StatusCode != http.StatusOK || !strings.Contains(text, "hello from sk-ant-api03-test") {
			t.Fatalf("official API stream: status %d body %s", resp.StatusCode, text)
		}
		sent, header := tb.upstream.last("sk-ant-api03-test")
		if sent != body {
			t.Fatalf("request body was rewritten:\n%s", sent)
		}
		if header.Get("Authorization") != "" || header.Get("Anthropic-Beta") != "fine-grained-tool-streaming-2025-05-14" {
			t.Fatalf("unexpected headers: %v", header)
		}
		resp = tb.request(t, http.MethodPost, APIPrefix+"api-keys", `{"name":"bad","key":"not-a-key"}`, nil)
		if text := readAll(t, resp); resp.StatusCode != http.StatusBadRequest || !strings.Contains(text, "key rejected") {
			t.Fatalf("invalid key accepted: status %d body %s", resp.StatusCode, text)
		}
		if data, err := os.ReadFile(filepath.Join(tb.home, "api-accounts.json")); err != nil || !strings.Contains(string(data), "sk-ant-api03-test") {
			t.Fatalf("API key not stored in the broker store: %v", err)
		}
		if files, _ := filepath.Glob(filepath.Join(tb.home, "auths", "*.json")); len(files) != 0 {
			t.Fatalf("CLIProxyAPI persisted a broker-managed credential: %v", files)
		}
	})

	t.Run("API-credit accounts sign in through ant and send its bearer token", func(t *testing.T) {
		httpStatus, login := tb.startLogin(t, `{"provider":"`+APICreditsLoginProvider+`","name":"team"}`)
		if httpStatus != http.StatusOK || login.State == "" || !strings.HasPrefix(login.URL, "https://console.example/") {
			t.Fatalf("credits login start: status %d %+v", httpStatus, login)
		}
		if text := readAll(t, tb.request(t, http.MethodGet, APIPrefix+"logins/"+login.State, "", nil)); !strings.Contains(text, `"wait"`) {
			t.Fatalf("credits login status before callback: %s", text)
		}
		status := tb.completeCreditsLogin(t, login)
		if status.Status != "ok" {
			t.Fatalf("credits login failed: %s", status.Error)
		}
		if status.Account.Kind != kindAPICredits || status.Account.Email != "credne-team@example.com" {
			t.Fatalf("credits account not registered: %+v", status)
		}
		resp := tb.request(t, http.MethodPost, routePath("a."+status.Account.Key, "claude"), `{"model":"claude-api-test","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`, nil)
		if text := readAll(t, resp); resp.StatusCode != http.StatusOK {
			t.Fatalf("credits stream: status %d body %s", resp.StatusCode, text)
		}
		_, header := tb.upstream.last("sk-ant-oat01-fake-credne-team")
		if header == nil || header.Get("X-Api-Key") != "" || !strings.Contains(header.Get("Anthropic-Beta"), anthropicOAuthBeta) {
			t.Fatalf("credits request did not use the ant bearer token with the OAuth beta: %v", header)
		}
		resp = tb.request(t, http.MethodDelete, APIPrefix+"accounts/"+status.Account.Key, "", nil)
		if text := readAll(t, resp); resp.StatusCode != http.StatusOK {
			t.Fatalf("remove credits account: status %d body %s", resp.StatusCode, text)
		}
		if _, err := os.Stat(filepath.Join(tb.home, "ant", "logged-in-credne-team")); !os.IsNotExist(err) {
			t.Fatal("removing the account did not log the ant profile out")
		}
	})

	t.Run("a pool replaces reasoning another account rejects with a summary and retries", func(t *testing.T) {
		key := tb.accountByID(t, "claude-api-key-console-key")
		tb.upstream.mu.Lock()
		tb.upstream.rejectThinking["sk-ant-api03-test"] = true
		tb.upstream.mu.Unlock()
		body := `{"model":"claude-api-test","stream":true,"max_tokens":64,"messages":[` +
			`{"role":"user","content":"first"},` +
			`{"role":"assistant","content":[{"type":"thinking","thinking":"plan from the other account","signature":"sig-other"},{"type":"text","text":"answer"}]},` +
			`{"role":"user","content":"next"}]}`
		resp := tb.request(t, http.MethodPost, routePath("p.claude", "claude"), body, map[string]string{"X-Session-Affinity": "session-retry"})
		if text := readAll(t, resp); resp.StatusCode != http.StatusOK || !strings.Contains(text, "message_stop") {
			t.Fatalf("pool retry: status %d body %s", resp.StatusCode, text)
		}
		if got := resp.Header.Get(AccountHeader); got != key.Key {
			t.Fatalf("served by %q, want %q", got, key.Key)
		}
		sent, _ := tb.upstream.last("sk-ant-api03-test")
		if strings.Contains(sent, `"type":"thinking"`) || !strings.Contains(sent, "plan from the other account") || !strings.Contains(sent, "Reasoning summary") {
			t.Fatalf("retried request does not carry a reasoning summary instead of the thinking block:\n%s", sent)
		}
	})

	t.Run("API-key accounts can be disabled and removed", func(t *testing.T) {
		key := tb.accountByID(t, "claude-api-key-console-key")
		resp := tb.request(t, http.MethodPost, APIPrefix+"accounts/"+key.Key+"/disable", "", nil)
		if text := readAll(t, resp); resp.StatusCode != http.StatusOK || !tb.accountByID(t, key.ID).Disabled {
			t.Fatalf("disable: status %d body %s", resp.StatusCode, text)
		}
		resp = tb.request(t, http.MethodPost, routePath("a."+key.Key, "claude"), probeBody("claude"), nil)
		if text := readAll(t, resp); resp.StatusCode != http.StatusForbidden {
			t.Fatalf("disabled account served a request: status %d body %s", resp.StatusCode, text)
		}
		resp = tb.request(t, http.MethodDelete, APIPrefix+"accounts/"+key.Key, "", nil)
		if text := readAll(t, resp); resp.StatusCode != http.StatusOK {
			t.Fatalf("remove: status %d body %s", resp.StatusCode, text)
		}
		for _, account := range tb.accounts(t) {
			if account.ID == key.ID {
				t.Fatal("removed account still listed")
			}
		}
	})

	t.Run("shutdown removes the discovery record", func(t *testing.T) {
		readAll(t, tb.request(t, http.MethodPost, APIPrefix+"shutdown", "", nil))
		select {
		case err := <-tb.done:
			tb.done <- err
		case <-time.After(10 * time.Second):
			t.Fatal("broker did not stop")
		}
		if _, err := os.Stat(statePath(tb.home)); !os.IsNotExist(err) {
			t.Fatalf("discovery record still present: %v", err)
		}
	})
}

// assertConflict checks a rejected duplicate: HTTP 409 with the user-facing text.
func assertConflict(t *testing.T, status int, message, want string) {
	t.Helper()
	if status != http.StatusConflict || message != want {
		t.Fatalf("status %d message %q, want 409 %q", status, message, want)
	}
}

func TestDuplicateAccounts(t *testing.T) {
	tb := startTestBroker(t)

	t.Run("the same API key is refused under a second name", func(t *testing.T) {
		if status, message := tb.addAPIKey(t, "one", "sk-ant-api03-one"); status != http.StatusOK {
			t.Fatalf("first add: status %d %s", status, message)
		}
		before := tb.accountIDs(t)
		status, message := tb.addAPIKey(t, "two", "sk-ant-api03-one")
		assertConflict(t, status, message, "This API key is already added as one.")
		if after := tb.accountIDs(t); after != before {
			t.Fatalf("accounts changed: %s -> %s", before, after)
		}
	})

	t.Run("a taken name is refused and keeps the stored key", func(t *testing.T) {
		before := tb.accountIDs(t)
		status, message := tb.addAPIKey(t, "One", "sk-ant-api03-other")
		assertConflict(t, status, message, "An API key account named one already exists.")
		if after := tb.accountIDs(t); after != before {
			t.Fatalf("accounts changed: %s -> %s", before, after)
		}
		data, err := os.ReadFile(filepath.Join(tb.home, "api-accounts.json"))
		if err != nil || !strings.Contains(string(data), "sk-ant-api03-one") || strings.Contains(string(data), "sk-ant-api03-other") {
			t.Fatalf("stored key was replaced: %v %s", err, data)
		}
	})

	t.Run("a config.yaml key is refused before the key is validated", func(t *testing.T) {
		config := tb.accountFor(t, "claude", "sk-ant-A")
		label := config.Label
		if label == "" {
			label = config.ID
		}
		// The fake upstream rejects this key as invalid, so a 409 proves the
		// duplicate check ran before the network validation.
		status, message := tb.addAPIKey(t, "again", "sk-ant-A")
		assertConflict(t, status, message, "This API key is already added as "+label+".")
	})

	t.Run("concurrent adds of one key store one account", func(t *testing.T) {
		const attempts = 4
		statuses := make([]int, attempts)
		var wg sync.WaitGroup
		for i := range attempts {
			wg.Add(1)
			go func() {
				defer wg.Done()
				statuses[i], _ = tb.addAPIKey(t, fmt.Sprintf("race-%d", i), "sk-ant-api03-race")
			}()
		}
		wg.Wait()
		added, refused := 0, 0
		for _, status := range statuses {
			switch status {
			case http.StatusOK:
				added++
			case http.StatusConflict:
				refused++
			}
		}
		if added != 1 || refused != attempts-1 {
			t.Fatalf("statuses %v, want one 200 and %d 409", statuses, attempts-1)
		}
	})

	t.Run("a taken API-credits name is refused before ant runs", func(t *testing.T) {
		tb.signInCredits(t, "team")
		before := tb.accountIDs(t)
		status, login := tb.startCreditsLogin(t, "Team")
		assertConflict(t, status, login.Error, "An API credits account named team already exists.")
		if after := tb.accountIDs(t); after != before {
			t.Fatalf("accounts changed: %s -> %s", before, after)
		}
		if _, err := os.Stat(filepath.Join(tb.home, "ant", "logged-in-credne-team")); err != nil {
			t.Fatalf("existing profile was touched: %v", err)
		}
	})

	t.Run("a name with a sign-in in progress is refused until that sign-in ends", func(t *testing.T) {
		status, pending := tb.startCreditsLogin(t, "pending")
		if status != http.StatusOK {
			t.Fatalf("first start: status %d %+v", status, pending)
		}
		status, second := tb.startCreditsLogin(t, "pending")
		assertConflict(t, status, second.Error, "An API credits sign-in named pending is already in progress. Finish or cancel it first.")
		if resp := tb.request(t, http.MethodDelete, APIPrefix+"logins/"+pending.State, "", nil); resp.StatusCode != http.StatusOK {
			t.Fatalf("cancel: status %d", resp.StatusCode)
		}
		status, again := tb.startCreditsLogin(t, "pending")
		if status != http.StatusOK {
			t.Fatalf("start after cancel: status %d %+v", status, again)
		}
		tb.request(t, http.MethodDelete, APIPrefix+"logins/"+again.State, "", nil)
	})

	t.Run("the same Console organization under a new name is refused and signed out", func(t *testing.T) {
		t.Setenv("FAKEANT_ORGANIZATION_UUID", "org-shared")
		tb.signInCredits(t, "first")
		httpStatus, login := tb.startCreditsLogin(t, "second")
		if httpStatus != http.StatusOK {
			t.Fatalf("start: status %d %+v", httpStatus, login)
		}
		status := tb.completeCreditsLogin(t, login)
		if want := "This Claude Console organization (Example Org) is already added as first."; status.Status != "error" || status.Error != want {
			t.Fatalf("login status %+v, want error %q", status, want)
		}
		if _, err := os.Stat(filepath.Join(tb.home, "ant", "logged-in-credne-second")); !os.IsNotExist(err) {
			t.Fatalf("rejected profile was not signed out: %v", err)
		}
		if _, err := os.Stat(filepath.Join(tb.home, "ant", "logged-in-credne-first")); err != nil {
			t.Fatalf("existing profile was touched: %v", err)
		}
		if got := tb.accountIDs(t); strings.Contains(got, "claude-api-credits-second") || !strings.Contains(got, "claude-api-credits-first") {
			t.Fatalf("accounts after the rejected login: %s", got)
		}
	})

	t.Run("a different Console organization is accepted", func(t *testing.T) {
		if account := tb.signInCredits(t, "third"); account.Kind != kindAPICredits {
			t.Fatalf("account %+v", account)
		}
	})
}

// assertSSEFramed checks that every event line is followed by its data line
// and every data line ends its event with a blank line.
func assertSSEFramed(t *testing.T, body string) {
	t.Helper()
	lines := strings.Split(body, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, "event:") && (i+1 >= len(lines) || !strings.HasPrefix(lines[i+1], "data:")) {
			t.Fatalf("event line %d not followed by data: %q", i, body)
		}
		if strings.HasPrefix(line, "data:") && (i+1 >= len(lines) || lines[i+1] != "") {
			t.Fatalf("data line %d not terminated by a blank line: %q", i, body)
		}
	}
}

func TestFrameChunk(t *testing.T) {
	cases := []struct {
		protocol, in, want string
	}{
		{protocolClaude, "event: ping\ndata: {}\n\n", "event: ping\ndata: {}\n\n"},
		{protocolOpenAIResponses, "event: response.created", "event: response.created\n"},
		{protocolOpenAIResponses, `data: {"type":"x"}`, "data: {\"type\":\"x\"}\n\n"},
		{protocolOpenAIResponses, "event: a\ndata: {}", "event: a\ndata: {}\n\n"},
		{protocolOpenAIResponses, "event: a\ndata: {}\n\n", "event: a\ndata: {}\n\n"},
		{protocolOpenAIChat, `{"id":"c"}`, "data: {\"id\":\"c\"}\n\n"},
		{protocolOpenAIChat, `data: {"id":"c"}`, "data: {\"id\":\"c\"}\n\n"},
		{protocolOpenAIChat, "[DONE]", "data: [DONE]\n\n"},
	}
	for _, tc := range cases {
		if got := string(frameChunk(tc.protocol, []byte(tc.in))); got != tc.want {
			t.Errorf("frameChunk(%s, %q) = %q, want %q", tc.protocol, tc.in, got, tc.want)
		}
	}
}

func TestParseTarget(t *testing.T) {
	pinned, err := parseTarget("a." + encodeKey("claude-x@example.com.json"))
	if err != nil || pinned.authID != "claude-x@example.com.json" || pinned.pool != "" {
		t.Fatalf("pinned target: %+v %v", pinned, err)
	}
	pool, err := parseTarget("p.Claude")
	if err != nil || pool.pool != "claude" || pool.authID != "" {
		t.Fatalf("pool target: %+v %v", pool, err)
	}
	for _, raw := range []string{"", "x.y", "a.", "a.!!!"} {
		if _, err := parseTarget(raw); err == nil {
			t.Fatalf("target %q accepted", raw)
		}
	}
}

func TestRuntimeConfigEnforcesLoopbackServer(t *testing.T) {
	home := t.TempDir()
	hostile := "server:\n  host: 0.0.0.0\n  port: 8317\nmanagement:\n  allow-remote: true\n  secret-key: user-secret\nplugins:\n  enabled: true\nobservability:\n  pprof:\n    enable: true\n"
	if err := os.WriteFile(filepath.Join(home, UserConfigFileName), []byte(hostile), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, _, err := buildRuntimeConfig(home, 45678, "locked")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "127.0.0.1" || cfg.Port != 45678 || cfg.RemoteManagement.AllowRemote || cfg.Plugins.Enabled || cfg.Pprof.Enable {
		t.Fatalf("user config overrode enforced settings: host=%s port=%d remote=%t plugins=%t pprof=%t",
			cfg.Host, cfg.Port, cfg.RemoteManagement.AllowRemote, cfg.Plugins.Enabled, cfg.Pprof.Enable)
	}
	data, err := os.ReadFile(filepath.Join(home, UserConfigFileName))
	if err != nil || string(data) != hostile {
		t.Fatal("user config file was modified")
	}
}

func TestAccountLimiterBoundsConcurrency(t *testing.T) {
	limiter := newAccountLimiter(1)
	release, err := limiter.acquire(context.Background(), "a")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err = limiter.acquire(ctx, "a"); err == nil {
		t.Fatal("second request on a saturated account was admitted")
	}
	if releaseOther, errOther := limiter.acquire(context.Background(), "b"); errOther != nil {
		t.Fatal("other account was blocked")
	} else {
		releaseOther()
	}
	release()
	if releaseAgain, errAgain := limiter.acquire(context.Background(), "a"); errAgain != nil {
		t.Fatal("slot was not released")
	} else {
		releaseAgain()
	}
}
