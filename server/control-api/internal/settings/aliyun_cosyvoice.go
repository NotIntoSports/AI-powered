package settings

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

const (
	cosyVoiceNamespace       = "FlowingSpeechSynthesizer"
	cosyVoiceSuccessStatus   = 20_000_000
	cosyVoiceSampleRate      = 24_000
	cosyVoiceSynthTimeout    = 60 * time.Second
	cosyVoicePreviewMaxBytes = 2 << 20
)

func isCosyVoiceTTSVoice(voice string) bool {
	voice = strings.TrimSpace(voice)
	if voice == "" || voice == defaultAliyunVoice {
		return false
	}
	return strings.HasPrefix(strings.ToLower(voice), "cosyvoice-") || voice != defaultAliyunVoice
}

func cosyVoiceFailureMessage(status int) string {
	switch status {
	case 40_000_010:
		return "阿里云 CosyVoice 商用版未开通（或试用期已结束/账号欠费），请在控制台开通后重试"
	case 40_000_001:
		return "音色不存在或无权限，请确认复刻音色已生成"
	default:
		if status == 0 {
			return "COSYVOICE_TTS_FAILED"
		}
		return fmt.Sprintf("COSYVOICE_TTS_%d", status)
	}
}

func aliyunGatewayWS(gateway string) string {
	gateway = strings.TrimRight(strings.TrimSpace(gateway), "/")
	if gateway == "" {
		gateway = defaultAliyunGate
	}
	if strings.HasPrefix(gateway, "https://") {
		return "wss://" + strings.TrimPrefix(gateway, "https://")
	}
	if strings.HasPrefix(gateway, "http://") {
		return "ws://" + strings.TrimPrefix(gateway, "http://")
	}
	if strings.HasPrefix(gateway, "wss://") || strings.HasPrefix(gateway, "ws://") {
		return gateway
	}
	return "wss://" + gateway
}

type cosyVoiceEnvelope struct {
	Header struct {
		Name          string `json:"name"`
		Status        int    `json:"status"`
		StatusMessage string `json:"status_message"`
		StatusText    string `json:"status_text"`
	} `json:"header"`
}

func synthesizeCosyVoiceSpeech(
	ctx context.Context,
	record SpeechRecord,
	accessKeyID, accessKeySecret, token, text string,
) ([]byte, string, error) {
	if strings.TrimSpace(record.AliyunAppKey) == "" {
		return nil, "请填写阿里云 Appkey", ErrInvalidInput
	}
	if strings.TrimSpace(token) == "" && (strings.TrimSpace(accessKeyID) == "" || strings.TrimSpace(accessKeySecret) == "") {
		return nil, "请填写 AccessKey ID 和 Secret，或临时 Token", ErrInvalidInput
	}
	resolved, err := resolveAliyunToken(ctx, nil, accessKeyID, accessKeySecret, token)
	if err != nil {
		if ctx.Err() != nil {
			return nil, "阿里云 Token 连接超时", err
		}
		return nil, "阿里云鉴权失败，请检查 AccessKey", err
	}
	voice := strings.TrimSpace(record.AliyunVoice)
	if voice == "" {
		voice = "longxiaochun"
	}
	if strings.TrimSpace(text) == "" {
		text = aliyunPreviewText
	}
	gateway := aliyunGatewayWS(record.AliyunGateway)
	wsURL := fmt.Sprintf("%s/ws/v1?token=%s", gateway, url.QueryEscape(resolved))
	taskID := strings.ReplaceAll(uuid.NewString(), "-", "")

	ctx, cancel := context.WithTimeout(ctx, cosyVoiceSynthTimeout)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPClient: &http.Client{Timeout: cosyVoiceSynthTimeout},
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, "阿里云 CosyVoice 连接超时", err
		}
		return nil, "无法连接阿里云 CosyVoice", err
	}
	defer conn.Close(websocket.StatusNormalClosure, "done")

	frames := make([][]byte, 0, 8)
	started := false
	completed := false
	failed := ""

	sendJSON := func(name string, payload map[string]any) error {
		envelope := map[string]any{
			"header": map[string]any{
				"message_id": strings.ReplaceAll(uuid.NewString(), "-", ""),
				"task_id":    taskID,
				"namespace":  cosyVoiceNamespace,
				"name":       name,
				"appkey":     strings.TrimSpace(record.AliyunAppKey),
			},
		}
		if payload != nil {
			envelope["payload"] = payload
		}
		raw, _ := json.Marshal(envelope)
		return conn.Write(ctx, websocket.MessageText, raw)
	}

	if err := sendJSON("StartSynthesis", map[string]any{
		"voice":       voice,
		"format":      "wav",
		"sample_rate": cosyVoiceSampleRate,
		"volume":      50,
		"speech_rate": 0,
		"pitch_rate":  0,
	}); err != nil {
		return nil, "无法连接阿里云 CosyVoice", err
	}

	for {
		if completed {
			break
		}
		typ, data, readErr := conn.Read(ctx)
		if readErr != nil {
			if completed {
				break
			}
			if failed != "" {
				return nil, failed, ErrInvalidInput
			}
			if ctx.Err() != nil {
				return nil, "阿里云 CosyVoice 连接超时", readErr
			}
			return nil, "阿里云 CosyVoice 连接中断", readErr
		}
		if typ == websocket.MessageBinary {
			if len(data) > 0 {
				chunk := make([]byte, len(data))
				copy(chunk, data)
				frames = append(frames, chunk)
			}
			continue
		}
		var envelope cosyVoiceEnvelope
		if json.Unmarshal(data, &envelope) != nil {
			continue
		}
		header := envelope.Header
		detail := strings.TrimSpace(header.StatusMessage)
		if detail == "" {
			detail = strings.TrimSpace(header.StatusText)
		}
		switch header.Name {
		case "SynthesisStarted":
			if header.Status != cosyVoiceSuccessStatus {
				failed = detail
				if failed == "" {
					failed = cosyVoiceFailureMessage(header.Status)
				}
				return nil, failed, ErrInvalidInput
			}
			started = true
			if err := sendJSON("RunSynthesis", map[string]any{"text": text}); err != nil {
				return nil, "阿里云 CosyVoice 合成失败", err
			}
			if err := sendJSON("StopSynthesis", nil); err != nil {
				return nil, "阿里云 CosyVoice 合成失败", err
			}
		case "SynthesisCompleted":
			completed = true
		case "TaskFailed":
			failed = detail
			if failed == "" {
				failed = cosyVoiceFailureMessage(header.Status)
			}
			return nil, failed, ErrInvalidInput
		default:
			if header.Status != 0 && header.Status != cosyVoiceSuccessStatus {
				failed = detail
				if failed == "" {
					failed = cosyVoiceFailureMessage(header.Status)
				}
				return nil, failed, ErrInvalidInput
			}
		}
		if completed {
			break
		}
		if !started && failed != "" {
			return nil, failed, ErrInvalidInput
		}
	}

	total := 0
	for _, frame := range frames {
		total += len(frame)
	}
	if !completed || total == 0 {
		if failed == "" {
			failed = "阿里云 CosyVoice 合成未返回音频"
		}
		return nil, failed, ErrInvalidInput
	}
	if total > cosyVoicePreviewMaxBytes {
		return nil, "试听音频过大", ErrInvalidInput
	}
	merged := make([]byte, 0, total)
	for _, frame := range frames {
		merged = append(merged, frame...)
	}
	return merged, "", nil
}

func synthesizeAliyunPreviewSpeech(
	ctx context.Context,
	client HTTPDoer,
	record SpeechRecord,
	accessKeyID, accessKeySecret, token, text string,
) ([]byte, string, error) {
	voice := strings.TrimSpace(record.AliyunVoice)
	if voice == "" {
		voice = defaultAliyunVoice
	}
	if isCosyVoiceTTSVoice(voice) {
		return synthesizeCosyVoiceSpeech(ctx, record, accessKeyID, accessKeySecret, token, text)
	}
	return synthesizeAliyunSpeech(ctx, client, record, accessKeyID, accessKeySecret, token, text)
}
