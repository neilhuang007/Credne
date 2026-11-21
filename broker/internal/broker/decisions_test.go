package broker

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

const decisionsRequest = `{"model":"gpt-6-luna","input":"{\"task\":\"fix a typo\"}","questions":[{"type":"score","name":"difficulty","instructions":"How hard is the task?","levels":[{"label":"easy"},{"label":"hard"}]}]}`

func decisionsRoute(target string) string { return APIPrefix + "route/" + target + "/decisions" }

// decisionsAnswer is what the fake upstream returns for a Decisions request made with key.
func decisionsAnswer(key string) string {
	return `{"model":"gpt-6-luna","answers":[],"path":"/v1/decisions","key":"` + key + `"}`
}

func TestDecisionsRoute(t *testing.T) {
	tb := startTestBroker(t)
	// CLIProxyAPI finishes its initial client load shortly after the broker is ready, and that load drops the
	// model lists of accounts added before it ends. The pool selects by model list, so add the keys after it.
	time.Sleep(time.Second)
	luna := tb.addOpenAIKey(t, "luna", "sk-openai-luna")
	spare := tb.addOpenAIKey(t, "spare", "sk-openai-spare")

	// refused sends a request the broker must answer itself and checks that no upstream saw it.
	refused := func(t *testing.T, target, body string, status int, message string) {
		t.Helper()
		before := tb.upstream.requestCount()
		resp := tb.request(t, http.MethodPost, decisionsRoute(target), body, nil)
		text := readAll(t, resp)
		if resp.StatusCode != status || !strings.Contains(text, message) || !strings.Contains(text, `"error"`) {
			t.Fatalf("%s: status %d body %s, want %d containing %q", target, resp.StatusCode, text, status, message)
		}
		if tb.upstream.requestCount() != before {
			t.Fatalf("%s: a refused request reached an upstream", target)
		}
	}

	t.Run("a pinned OpenAI key gets the body and returns the answer unchanged", func(t *testing.T) {
		resp := tb.request(t, http.MethodPost, decisionsRoute("a."+luna.Key), decisionsRequest, map[string]string{"X-Credne-Client": "test"})
		text := readAll(t, resp)
		if resp.StatusCode != http.StatusOK || text != decisionsAnswer("sk-openai-luna") {
			t.Fatalf("pinned decisions: status %d body %s", resp.StatusCode, text)
		}
		if got := resp.Header.Get(AccountHeader); got != luna.Key {
			t.Fatalf("account header %q, want %q", got, luna.Key)
		}
		if resp.Header.Get("Content-Type") != "application/json" || resp.Header.Get("X-Request-Id") != "req_fake" {
			t.Fatalf("upstream headers were not passed on: %v", resp.Header)
		}
		if resp.Header.Get("Set-Cookie") != "" {
			t.Fatal("an upstream cookie reached the client")
		}
		sent, header := tb.upstream.last("sk-openai-luna")
		if sent != decisionsRequest {
			t.Fatalf("request body was rewritten:\n%s", sent)
		}
		if header.Get("Authorization") != "Bearer sk-openai-luna" || header.Get("X-Credne-Client") != "" {
			t.Fatalf("upstream did not get the account key alone: %v", header)
		}
	})

	t.Run("upstream errors keep their status, body and retry hint, and do not cool the account", func(t *testing.T) {
		tb.upstream.setFail("sk-openai-luna", http.StatusTooManyRequests)
		defer tb.upstream.setFail("sk-openai-luna", 0)
		resp := tb.request(t, http.MethodPost, decisionsRoute("a."+luna.Key), decisionsRequest, nil)
		text := readAll(t, resp)
		want := `{"type":"error","error":{"type":"rate_limit_error","message":"key sk-openai-luna is rate limited"}}`
		if resp.StatusCode != http.StatusTooManyRequests || text != want || resp.Header.Get("Retry-After") != "7" {
			t.Fatalf("upstream failure: status %d retry-after %q body %s", resp.StatusCode, resp.Header.Get("Retry-After"), text)
		}
		if state := tb.account(t, luna.Key); state.QuotaExceeded || state.RetryAfter != nil {
			t.Fatalf("a Decisions failure changed the account's chat routing state: %+v", state)
		}
	})

	t.Run("pool openai is served by one of its keys and skips a disabled one", func(t *testing.T) {
		for range 4 {
			resp := tb.request(t, http.MethodPost, decisionsRoute("p.openai"), decisionsRequest, nil)
			text := readAll(t, resp)
			served := resp.Header.Get(AccountHeader)
			if resp.StatusCode != http.StatusOK || (served != luna.Key && served != spare.Key) {
				t.Fatalf("pool decisions: status %d served by %q body %s", resp.StatusCode, served, text)
			}
		}
		resp := tb.request(t, http.MethodPost, APIPrefix+"accounts/"+spare.Key+"/disable", "", nil)
		if text := readAll(t, resp); resp.StatusCode != http.StatusOK {
			t.Fatalf("disable: status %d body %s", resp.StatusCode, text)
		}
		defer func() { readAll(t, tb.request(t, http.MethodPost, APIPrefix+"accounts/"+spare.Key+"/enable", "", nil)) }()
		before := tb.upstream.count("sk-openai-spare")
		for range 4 {
			resp = tb.request(t, http.MethodPost, decisionsRoute("p.openai"), decisionsRequest, nil)
			text := readAll(t, resp)
			if resp.StatusCode != http.StatusOK || resp.Header.Get(AccountHeader) != luna.Key || !strings.Contains(text, "sk-openai-luna") {
				t.Fatalf("pool with a disabled key: status %d served by %q body %s", resp.StatusCode, resp.Header.Get(AccountHeader), text)
			}
		}
		if tb.upstream.count("sk-openai-spare") != before {
			t.Fatal("the pool sent a request to the disabled key")
		}
		refused(t, "a."+spare.Key, decisionsRequest, http.StatusForbidden, "is disabled")
	})

	t.Run("the pool refuses a model none of its keys lists", func(t *testing.T) {
		body := strings.Replace(decisionsRequest, "gpt-6-luna", "gpt-unlisted", 1)
		refused(t, "p.openai", body, http.StatusServiceUnavailable, "no enabled OpenAI API-key account serves gpt-unlisted")
	})

	t.Run("subscriptions, API-key accounts of other providers and other pools are refused", func(t *testing.T) {
		for _, provider := range []string{"codex", "claude"} {
			account := accountOfProvider(t, tb, provider)
			refused(t, "a."+account.Key, decisionsRequest, http.StatusBadRequest, "is not an OpenAI API-key account")
		}
		for _, pool := range []string{"codex", "claude", "all"} {
			refused(t, "p."+pool, decisionsRequest, http.StatusBadRequest, "cannot serve the Decisions API")
		}
	})

	t.Run("unknown targets and malformed bodies are refused", func(t *testing.T) {
		refused(t, "a."+encodeKey("missing"), decisionsRequest, http.StatusNotFound, "not found")
		refused(t, "x.openai", decisionsRequest, http.StatusBadRequest, "invalid route target")
		refused(t, "p.openai", `{"input":"no model"}`, http.StatusBadRequest, "request body must be JSON with a model")
		refused(t, "a."+luna.Key, `not json`, http.StatusBadRequest, "request body must be JSON with a model")
	})
}

// requestCount is the number of requests that reached a model route of the fake upstream.
func (f *fakeUpstream) requestCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.bodies)
}

// accountOfProvider returns the first listed account of a CLIProxyAPI provider key.
func accountOfProvider(t *testing.T, tb *testBroker, provider string) accountView {
	t.Helper()
	for _, account := range tb.accounts(t) {
		if account.Provider == provider {
			return account
		}
	}
	t.Fatalf("no %s account listed", provider)
	return accountView{}
}
