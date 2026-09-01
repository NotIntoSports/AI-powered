package settings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const (
	RealtimeVerificationUntested = "untested"
	RealtimeVerificationVerified = "verified"
	RealtimeVerificationFailed   = "failed"
	RealtimeVerificationStale    = "stale"
	realtimeProbeTimeout         = 10 * time.Second
)

type RealtimeProbeResult struct {
	Supported bool   `json:"supported"`
	Status    string `json:"status"`
	Message   string `json:"message,omitempty"`
}

type RealtimeVerificationError struct{ Code string }

func (e *RealtimeVerificationError) Error() string { return e.Code }

func realtimeEndpoint(baseURL, modelID string) (string, string, error) {
	raw := strings.TrimSpace(baseURL)
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || strings.TrimSpace(modelID) == "" {
		return "", "", ErrInvalidInput
	}
	switch parsed.Scheme {
	case "https":
		parsed.Scheme = "wss"
	case "http":
		parsed.Scheme = "ws"
	case "wss", "ws":
	default:
		return "", "", ErrInvalidInput
	}
	lowerHost := strings.ToLower(parsed.Hostname())
	lowerPath := strings.ToLower(strings.TrimRight(parsed.Path, "/"))
	aliyun := strings.Contains(lowerPath, "compatible-mode") ||
		strings.HasSuffix(lowerPath, "/api-ws/v1/realtime") ||
		strings.Contains(lowerHost, "dashscope") || strings.Contains(lowerHost, "token-plan")
	format := "pcm16"
	if aliyun {
		parsed.Path = "/api-ws/v1/realtime"
		format = "pcm"
	} else if !strings.HasSuffix(lowerPath, "/realtime") {
		parsed.Path = strings.TrimRight(parsed.Path, "/") + "/realtime"
	}
	parsed.RawQuery = url.Values{"model": []string{strings.TrimSpace(modelID)}}.Encode()
	parsed.Fragment = ""
	return parsed.String(), format, nil
}

func probeRealtime(ctx context.Context, baseURL, modelID, apiKey string) RealtimeProbeResult {
	endpoint, format, err := realtimeEndpoint(baseURL, modelID)
	if err != nil {
		return RealtimeProbeResult{Status: RealtimeVerificationFailed, Message: "REALTIME_URL_INVALID"}
	}
	probeCtx, cancel := context.WithTimeout(ctx, realtimeProbeTimeout)
	defer cancel()
	conn, _, err := websocket.Dial(probeCtx, endpoint, &websocket.DialOptions{HTTPHeader: http.Header{
		"Authorization": []string{"Bearer " + strings.TrimSpace(apiKey)},
		"OpenAI-Beta":   []string{"realtime=v1"},
	}})
	if err != nil {
		return RealtimeProbeResult{Status: RealtimeVerificationFailed, Message: realtimeProbeError(err)}
	}
	defer conn.CloseNow()
	event := map[string]any{
		"type": "session.update",
		"session": map[string]any{
			"modalities":          []string{"text", "audio"},
			"input_audio_format":  format,
			"output_audio_format": format,
		},
	}
	body, _ := json.Marshal(event)
	if err := conn.Write(probeCtx, websocket.MessageText, body); err != nil {
		return RealtimeProbeResult{Status: RealtimeVerificationFailed, Message: realtimeProbeError(err)}
	}
	for {
		_, message, err := conn.Read(probeCtx)
		if err != nil {
			return RealtimeProbeResult{Status: RealtimeVerificationFailed, Message: realtimeProbeError(err)}
		}
		var incoming struct {
			Type  string `json:"type"`
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(message, &incoming) != nil {
			continue
		}
		switch incoming.Type {
		case "session.updated":
			return RealtimeProbeResult{Supported: true, Status: RealtimeVerificationVerified, Message: "REALTIME_VERIFIED"}
		case "error":
			code := sanitizeRealtimeCode(incoming.Error.Code)
			if code == "" {
				code = "REALTIME_SERVER_ERROR"
			}
			return RealtimeProbeResult{Status: RealtimeVerificationFailed, Message: code}
		}
	}
}

func realtimeProbeError(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "REALTIME_SESSION_UPDATE_TIMEOUT"
	}
	return "REALTIME_CONNECTION_FAILED"
}

func sanitizeRealtimeCode(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	var b strings.Builder
	for _, r := range value {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
		}
		if b.Len() >= 80 {
			break
		}
	}
	return b.String()
}

func realtimeLogTarget(baseURL, modelID string) string {
	endpoint, _, err := realtimeEndpoint(baseURL, modelID)
	if err != nil {
		return "invalid"
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return "invalid"
	}
	return fmt.Sprintf("%s%s", parsed.Host, parsed.Path)
}
