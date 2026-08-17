package settings

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type AITestResult struct {
	Reachable  bool     `json:"reachable"`
	ModelFound bool     `json:"modelFound"`
	Models     []string `json:"models"`
	Message    string   `json:"message"`
}

type RTCTestResult struct {
	Reachable bool   `json:"reachable"`
	Provider  string `json:"provider,omitempty"`
	Message   string `json:"message"`
}

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

func ProbeAI(ctx context.Context, client HTTPDoer, baseURL, apiKey, model string) AITestResult {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/models", nil)
	if err != nil {
		return AITestResult{Message: "无法连接模型服务"}
	}
	if apiKey != "" {
		request.Header.Set("Authorization", "Bearer "+apiKey)
	}
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return AITestResult{Message: "模型服务连接超时"}
		}
		return AITestResult{Message: "无法连接模型服务"}
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return AITestResult{Message: "模型服务不可达"}
	}
	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return AITestResult{Reachable: true, Message: "服务可达，但没有返回可用模型"}
	}
	models := make([]string, 0, len(parsed.Data))
	seen := map[string]struct{}{}
	for _, item := range parsed.Data {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		models = append(models, id)
		if len(models) >= 100 {
			break
		}
	}
	found := false
	for _, id := range models {
		if id == model {
			found = true
			break
		}
	}
	message := "服务可达，但没有返回可用模型"
	if found {
		message = "连接正常，已找到模型 " + model
	} else if len(models) > 0 {
		message = "服务可达，但未找到模型 " + model
	}
	return AITestResult{Reachable: true, ModelFound: found, Models: models, Message: message}
}

func ProbeRTC(record RTCRecord, decryptErr error) RTCTestResult {
	provider := record.ActiveProvider
	if provider == "" {
		provider = ProviderVolcengine
	}
	var public PublicRTC
	if provider == ProviderLiveKit {
		public = PublicRTCFrom(record, nil, decryptErr)
	} else {
		public = PublicRTCFrom(record, decryptErr, nil)
	}
	if !public.Configured {
		return RTCTestResult{Message: "尚未配置 RTC"}
	}
	if decryptErr != nil {
		return RTCTestResult{Message: "RTC 密钥无法解密"}
	}
	if provider == ProviderLiveKit {
		if !public.LiveKitAvailable {
			return RTCTestResult{Provider: provider, Message: "LiveKit 配置不完整或已停用"}
		}
		return RTCTestResult{Reachable: true, Provider: provider, Message: "LiveKit 配置可用"}
	}
	if !public.VolcengineAvailable {
		return RTCTestResult{Provider: provider, Message: "火山 RTC 配置不完整或已停用"}
	}
	return RTCTestResult{Reachable: true, Provider: provider, Message: "火山 RTC 配置可用"}
}

func ProbeLiveKit(ctx context.Context, client HTTPDoer, livekitURL string) RTCTestResult {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	target := livekitHTTPURL(livekitURL)
	if target == "" {
		return RTCTestResult{Provider: ProviderLiveKit, Message: "尚未配置 LiveKit"}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return RTCTestResult{Provider: ProviderLiveKit, Message: "无法连接 LiveKit"}
	}
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return RTCTestResult{Provider: ProviderLiveKit, Message: "LiveKit 连接超时"}
		}
		return RTCTestResult{Provider: ProviderLiveKit, Message: "无法连接 LiveKit"}
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<16))
	if response.StatusCode >= 500 {
		return RTCTestResult{Provider: ProviderLiveKit, Message: "LiveKit 不可达"}
	}
	return RTCTestResult{Reachable: true, Provider: ProviderLiveKit, Message: "LiveKit 服务可达"}
}

func ProbeSpeech(ctx context.Context, client HTTPDoer, record SpeechRecord, apiKey, accessToken string, decryptErr error) SpeechTestResult {
	return probeVolcengineSpeech(ctx, client, record, apiKey, accessToken, decryptErr)
}

func ProbeSpeechLine(
	ctx context.Context,
	client HTTPDoer,
	record SpeechRecord,
	provider, apiKey, accessToken, aliyunID, aliyunSecret, aliyunToken string,
	volcErr, aliyunErr error,
) SpeechTestResult {
	if provider == SpeechProviderAliyun {
		return probeAliyunSpeech(ctx, client, record, aliyunID, aliyunSecret, aliyunToken, aliyunErr)
	}
	return probeVolcengineSpeech(ctx, client, record, apiKey, accessToken, volcErr)
}

func probeVolcengineSpeech(ctx context.Context, client HTTPDoer, record SpeechRecord, apiKey, accessToken string, decryptErr error) SpeechTestResult {
	public := PublicSpeechFromErrs(record, decryptErr, nil)
	if !public.Configured {
		return SpeechTestResult{Provider: SpeechProviderVolcengine, Message: "尚未配置豆包语音"}
	}
	if decryptErr != nil {
		return SpeechTestResult{Provider: SpeechProviderVolcengine, Message: "语音密钥无法解密"}
	}
	if !record.Enabled {
		return SpeechTestResult{Provider: SpeechProviderVolcengine, Message: "豆包语音已停用"}
	}
	if !public.VolcengineAvailable {
		return SpeechTestResult{Provider: SpeechProviderVolcengine, Message: "请填写 API Key，或同时填写 AppID 和 Access Token"}
	}
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	speakerID := record.SpeakerID
	if speakerID == "" {
		speakerID = "custom_zh_interviewer"
	}
	body, _ := json.Marshal(map[string]string{"speaker_id": speakerID})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://openspeech.bytedance.com/api/v3/tts/get_voice", strings.NewReader(string(body)))
	if err != nil {
		return SpeechTestResult{Provider: SpeechProviderVolcengine, Message: "无法连接豆包语音"}
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Api-Request-Id", "speech-probe")
	if strings.TrimSpace(apiKey) != "" {
		request.Header.Set("X-Api-Key", strings.TrimSpace(apiKey))
	} else {
		request.Header.Set("X-Api-App-Key", record.AppID)
		request.Header.Set("X-Api-Access-Key", strings.TrimSpace(accessToken))
	}
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return SpeechTestResult{Provider: SpeechProviderVolcengine, Message: "豆包语音连接超时"}
		}
		return SpeechTestResult{Provider: SpeechProviderVolcengine, Message: "无法连接豆包语音"}
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<16))
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return SpeechTestResult{Provider: SpeechProviderVolcengine, Message: "豆包语音鉴权失败，请检查 API Key 或 AppID/Token"}
	}
	if response.StatusCode >= 500 {
		return SpeechTestResult{Provider: SpeechProviderVolcengine, Message: "豆包语音暂时不可达"}
	}
	message := "豆包语音鉴权可用"
	if public.TTSAvailable && record.SpeakerID != "" {
		message = "豆包语音可用，已配置复刻音色"
	} else {
		message = "豆包语音鉴权可用。请在客户端录音完成声音刻录后再用于面试播报。"
	}
	return SpeechTestResult{Reachable: true, Provider: SpeechProviderVolcengine, Message: message}
}

func livekitHTTPURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	switch parsed.Scheme {
	case "ws":
		parsed.Scheme = "http"
	case "wss":
		parsed.Scheme = "https"
	case "http", "https":
	default:
		return ""
	}
	return strings.TrimRight(parsed.String(), "/")
}
