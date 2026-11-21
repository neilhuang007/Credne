package broker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// Native protocols the broker accepts. Requests are executed in the same
// protocol they arrive in (entry == exit), so no capability is lost to a
// common intermediate format; CLIProxyAPI only adapts the payload to the
// selected account's upstream (for example Responses -> ChatGPT Codex).
const (
	protocolClaude          = "claude"
	protocolOpenAIResponses = "openai-response"
	protocolOpenAIChat      = "openai"
)

var upstreamPaths = map[string]string{
	protocolClaude:          "/v1/messages",
	protocolOpenAIResponses: "/v1/responses",
	protocolOpenAIChat:      "/v1/chat/completions",
}

// maxRequestBytes bounds request bodies; image-heavy transcripts stay well below it.
const maxRequestBytes = 64 << 20

// AccountHeader names the account that served a request, base64url encoded.
// For pools it reports CLIProxyAPI's selection.
const AccountHeader = "X-Credne-Account"

// routeTarget is either a pinned account (authID set) or a named pool.
// Pools do not force a provider: CLIProxyAPI selects among every account
// that serves the requested model, so a Claude model is funded by Claude
// subscriptions, API-credit accounts and API keys alike.
type routeTarget struct {
	authID string
	pool   string
}

// parseTarget decodes "a.<base64url auth id>" (pinned) or "p.<pool name>" (pool).
func parseTarget(raw string) (routeTarget, error) {
	kind, value, ok := strings.Cut(raw, ".")
	if !ok || value == "" {
		return routeTarget{}, fmt.Errorf("invalid route target %q", raw)
	}
	switch kind {
	case "a":
		id, err := decodeKey(value)
		if err != nil {
			return routeTarget{}, err
		}
		return routeTarget{authID: id}, nil
	case "p":
		return routeTarget{pool: strings.ToLower(value)}, nil
	}
	return routeTarget{}, fmt.Errorf("invalid route target %q", raw)
}

func encodeKey(authID string) string { return base64.RawURLEncoding.EncodeToString([]byte(authID)) }

func decodeKey(key string) (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(key)
	if err != nil || len(raw) == 0 {
		return "", fmt.Errorf("invalid account key %q", key)
	}
	return string(raw), nil
}

// requestHead is the part of a request body the broker reads; the body itself is forwarded as sent.
type requestHead struct {
	Model  string `json:"model"`
	Stream bool   `json:"stream"`
}

// readRequest reads a size-bounded JSON body that names a model. When it cannot, it answers the
// client and reports false.
func readRequest(c *gin.Context, protocol string) ([]byte, requestHead, bool) {
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, maxRequestBytes+1))
	if err != nil {
		writeError(c, protocol, http.StatusBadRequest, "failed to read request body", nil)
		return nil, requestHead{}, false
	}
	if len(body) > maxRequestBytes {
		writeError(c, protocol, http.StatusRequestEntityTooLarge, "request body too large", nil)
		return nil, requestHead{}, false
	}
	var head requestHead
	if err = json.Unmarshal(body, &head); err != nil || head.Model == "" {
		writeError(c, protocol, http.StatusBadRequest, "request body must be JSON with a model", nil)
		return nil, requestHead{}, false
	}
	return body, head, true
}

// pinnedAccount resolves the account a pinned target names, with the label that error messages
// use for it. A missing or disabled account is answered to the client and reported as false.
func (s *server) pinnedAccount(c *gin.Context, protocol, authID string) (*coreauth.Auth, string, bool) {
	auth, ok := s.handler.AuthManager.GetByID(authID)
	if !ok {
		writeError(c, protocol, http.StatusNotFound, fmt.Sprintf("account %s not found", authID), nil)
		return nil, "", false
	}
	label := "account " + accountName(auth)
	if auth.Disabled {
		writeError(c, protocol, http.StatusForbidden, label+" is disabled", nil)
		return nil, "", false
	}
	return auth, label, true
}

// execute serves one native-protocol request for a pinned account or a pool.
func (s *server) execute(protocol string) gin.HandlerFunc {
	return func(c *gin.Context) {
		target, err := parseTarget(c.Param("target"))
		if err != nil {
			writeError(c, protocol, http.StatusBadRequest, err.Error(), nil)
			return
		}
		body, head, ok := readRequest(c, protocol)
		if !ok {
			return
		}

		ctx := c.Request.Context()
		provider := ""
		// OpenAI API keys and Codex subscriptions share model IDs but have separate billing routes.
		switch target.pool {
		case "openai":
			provider = OpenAIAPIProviderKey
		case "codex":
			provider = "codex"
		}
		label := "pool " + target.pool
		if target.authID != "" {
			auth, accountLabel, found := s.pinnedAccount(c, protocol, target.authID)
			if !found {
				return
			}
			label = accountLabel
			provider = strings.ToLower(auth.Provider)
			release, errAcquire := s.limiter.acquire(ctx, target.authID)
			if errAcquire != nil {
				return
			}
			defer release()
			// The conductor only selects this auth; when it fails the request
			// fails. It never falls back to another account.
			ctx = handlers.WithPinnedAuthID(ctx, target.authID)
		}
		var selected atomic.Pointer[string]
		ctx = handlers.WithSelectedAuthIDCallback(ctx, func(id string) { selected.Store(&id) })

		req := handlers.ProtocolExecutionRequest{
			EntryProtocol:  protocol,
			ExitProtocol:   protocol,
			ForcedProvider: provider,
			Model:          head.Model,
			Stream:         head.Stream,
			Body:           body,
			Headers:        forwardHeaders(c.Request.Header),
			Path:           upstreamPaths[protocol],
		}
		session := ""
		if target.authID == "" {
			session = sessionKey(c.Param("target"), c.Request.Header)
		}
		result := s.run(ctx, protocol, session, req)
		if result.err != nil {
			writeExecutionError(c, protocol, label, result.err.StatusCode, result.err.Error, result.err.Addon)
			return
		}
		if id := selected.Load(); id != nil && session != "" {
			s.sessions.set(session, *id)
		}
		setAccountHeader(c.Writer.Header(), &selected)
		if result.stream != nil {
			writeStream(c, protocol, label, *result.stream)
		} else {
			writeResponse(c, result.response)
		}
	}
}

// executionResult holds a stream, a complete response, or an error.
type executionResult struct {
	stream   *handlers.ModelExecutionStream
	response handlers.ModelExecutionResponse
	err      *executionError
}

// executionError is the part of CLIProxyAPI's error message the broker uses.
type executionError struct {
	StatusCode int
	Error      error
	Addon      http.Header
}

// run executes a request. For pools it first strips replayed reasoning when
// the conversation's previous account can no longer be selected, and retries
// once without reasoning when an account rejects another account's reasoning.
func (s *server) run(ctx context.Context, protocol, session string, req handlers.ProtocolExecutionRequest) executionResult {
	stripped := false
	if session != "" {
		if last := s.sessions.get(session); last != "" {
			auth, ok := s.handler.AuthManager.GetByID(last)
			if !ok || !selectable(auth, time.Now()) {
				req.Body, stripped = stripReasoning(protocol, req.Body)
			}
		}
	}
	result := s.call(ctx, req)
	if session == "" || stripped || result.err == nil {
		return result
	}
	message := ""
	if result.err.Error != nil {
		message = result.err.Error.Error()
	}
	if !isReasoningRejection(result.err.StatusCode, message) {
		return result
	}
	if body, changed := stripReasoning(protocol, req.Body); changed {
		req.Body = body
		return s.call(ctx, req)
	}
	return result
}

func (s *server) call(ctx context.Context, req handlers.ProtocolExecutionRequest) executionResult {
	if req.Stream {
		st, errMsg := s.handler.ExecuteProtocolStreamWithAuthManager(ctx, req)
		if errMsg != nil {
			return executionResult{err: &executionError{StatusCode: errMsg.StatusCode, Error: errMsg.Error, Addon: errMsg.Addon}}
		}
		return executionResult{stream: &st}
	}
	resp, errMsg := s.handler.ExecuteProtocolWithAuthManager(ctx, req)
	if errMsg != nil {
		return executionResult{err: &executionError{StatusCode: errMsg.StatusCode, Error: errMsg.Error, Addon: errMsg.Addon}}
	}
	return executionResult{response: resp}
}

func writeResponse(c *gin.Context, resp handlers.ModelExecutionResponse) {
	contentType := resp.Headers.Get("Content-Type")
	if contentType == "" {
		contentType = "application/json"
	}
	status := resp.StatusCode
	if status == 0 {
		status = http.StatusOK
	}
	c.Data(status, contentType, resp.Body)
}

func writeStream(c *gin.Context, protocol, label string, st handlers.ModelExecutionStream) {
	w := c.Writer
	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache")
	header.Set("X-Accel-Buffering", "no")
	status := st.StatusCode
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	w.Flush()
	// A client disconnect cancels ctx, which stops the upstream request.
	sawDone := false
	for chunk := range st.Chunks {
		if chunk.Err != nil {
			_, _ = w.Write(streamErrorEvent(protocol, chunk.Err.StatusCode, label+": "+upstreamMessage(chunk.Err.Message)))
			w.Flush()
			return
		}
		if len(bytes.TrimSpace(chunk.Payload)) == 0 {
			continue
		}
		framed := frameChunk(protocol, chunk.Payload)
		sawDone = sawDone || bytes.Equal(framed, chatDone)
		if _, err := w.Write(framed); err != nil {
			return
		}
		w.Flush()
	}
	if protocol == protocolOpenAIChat && !sawDone {
		_, _ = w.Write(chatDone)
		w.Flush()
	}
}

var chatDone = []byte("data: [DONE]\n\n")

// frameChunk turns one executor chunk into wire SSE, mirroring the framing
// CLIProxyAPI's own HTTP handlers apply per protocol:
//   - claude: chunks are complete SSE events and pass through verbatim;
//   - openai-response: chunks are SSE field lines without terminators; a
//     data line ends its event with a blank line;
//   - openai (chat completions): chunks are bare JSON payloads.
func frameChunk(protocol string, chunk []byte) []byte {
	switch protocol {
	case protocolOpenAIResponses:
		if bytes.HasSuffix(chunk, []byte("\n\n")) {
			return chunk
		}
		lines := bytes.TrimRight(chunk, "\r\n")
		framed := append(make([]byte, 0, len(lines)+2), lines...)
		if bytes.HasPrefix(lines[bytes.LastIndexByte(lines, '\n')+1:], []byte("data:")) {
			return append(framed, '\n', '\n')
		}
		return append(framed, '\n')
	case protocolOpenAIChat:
		payload := bytes.TrimSpace(chunk)
		if bytes.HasPrefix(payload, []byte("data:")) {
			payload = bytes.TrimSpace(payload[len("data:"):])
		}
		return append(append([]byte("data: "), payload...), '\n', '\n')
	}
	return chunk
}

func setAccountHeader(header http.Header, selected *atomic.Pointer[string]) {
	if id := selected.Load(); id != nil && *id != "" {
		header.Set(AccountHeader, encodeKey(*id))
	}
}

// droppedRequestHeaders never reach CLIProxyAPI: the broker token, hop-by-hop
// headers, and encodings the broker negotiates itself.
var droppedRequestHeaders = map[string]bool{
	"Authorization":       true,
	"X-Api-Key":           true,
	"Proxy-Authorization": true,
	"Cookie":              true,
	"Host":                true,
	"Content-Length":      true,
	"Connection":          true,
	"Keep-Alive":          true,
	"Te":                  true,
	"Trailer":             true,
	"Transfer-Encoding":   true,
	"Upgrade":             true,
	"Accept-Encoding":     true,
}

func forwardHeaders(in http.Header) http.Header {
	out := make(http.Header, len(in))
	for key, values := range in {
		canonical := http.CanonicalHeaderKey(key)
		if droppedRequestHeaders[canonical] || strings.HasPrefix(canonical, "X-Credne-") {
			continue
		}
		out[canonical] = append([]string(nil), values...)
	}
	return out
}

func writeExecutionError(c *gin.Context, protocol, label string, status int, err error, addon http.Header) {
	if status == 0 {
		status = http.StatusBadGateway
	}
	message := http.StatusText(status)
	if err != nil {
		message = upstreamMessage(err.Error())
	}
	retry := http.Header{}
	if values := coreauth.SafeResponseHeaders(err).Values("Retry-After"); len(values) > 0 {
		retry["Retry-After"] = values
	} else if values = addon.Values("Retry-After"); len(values) > 0 {
		retry["Retry-After"] = values
	}
	writeError(c, protocol, status, label+": "+message, retry)
}

// upstreamMessage extracts the human-readable message from an upstream error
// body when it is JSON, so nested provider envelopes are not shown verbatim.
func upstreamMessage(text string) string {
	trimmed := strings.TrimSpace(text)
	var envelope struct {
		Message string `json:"message"`
		Error   *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if strings.HasPrefix(trimmed, "{") && json.Unmarshal([]byte(trimmed), &envelope) == nil {
		if envelope.Error != nil && envelope.Error.Message != "" {
			return envelope.Error.Message
		}
		if envelope.Message != "" {
			return envelope.Message
		}
	}
	if trimmed == "" {
		return "upstream error"
	}
	return trimmed
}

func writeError(c *gin.Context, protocol string, status int, message string, header http.Header) {
	for _, value := range header.Values("Retry-After") {
		c.Writer.Header().Add("Retry-After", value)
	}
	c.Data(status, "application/json", errorBody(protocol, status, message))
	c.Abort()
}

func errorBody(protocol string, status int, message string) []byte {
	var body any
	if protocol == protocolClaude {
		body = map[string]any{"type": "error", "error": map[string]any{"type": claudeErrorType(status), "message": message}}
	} else {
		body = map[string]any{"error": map[string]any{"message": message, "type": openAIErrorType(status), "code": openAIErrorCode(status)}}
	}
	data, err := json.Marshal(body)
	if err != nil {
		return []byte(`{"error":{"message":"internal error"}}`)
	}
	return data
}

// streamErrorEvent renders a terminal error in the stream framing the
// client's SDK parses for that protocol.
func streamErrorEvent(protocol string, status int, message string) []byte {
	switch protocol {
	case protocolClaude:
		return []byte("event: error\ndata: " + string(errorBody(protocol, status, message)) + "\n\n")
	case protocolOpenAIResponses:
		data, _ := json.Marshal(map[string]any{"type": "error", "code": openAIErrorCode(status), "message": message})
		return []byte("event: error\ndata: " + string(data) + "\n\n")
	}
	return []byte("data: " + string(errorBody(protocol, status, message)) + "\n\n")
}

func claudeErrorType(status int) string {
	switch {
	case status == http.StatusBadRequest:
		return "invalid_request_error"
	case status == http.StatusUnauthorized:
		return "authentication_error"
	case status == http.StatusForbidden:
		return "permission_error"
	case status == http.StatusNotFound:
		return "not_found_error"
	case status == http.StatusRequestEntityTooLarge:
		return "request_too_large"
	case status == http.StatusTooManyRequests:
		return "rate_limit_error"
	case status == 529:
		return "overloaded_error"
	}
	return "api_error"
}

func openAIErrorType(status int) string {
	if status >= 500 {
		return "server_error"
	}
	if status == http.StatusTooManyRequests {
		return "rate_limit_error"
	}
	return "invalid_request_error"
}

func openAIErrorCode(status int) string {
	switch status {
	case http.StatusTooManyRequests:
		return "rate_limit_exceeded"
	case http.StatusUnauthorized:
		return "invalid_api_key"
	case http.StatusForbidden:
		return "permission_denied"
	case http.StatusNotFound:
		return "not_found"
	}
	if status >= 500 {
		return "server_error"
	}
	return "invalid_request"
}
