package settings

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	aliyunTokenHost    = "https://nls-meta.cn-shanghai.aliyuncs.com/"
	defaultAliyunVoice = "xiaoyun"
	defaultAliyunGate  = "https://nls-gateway-cn-shanghai.aliyuncs.com"
)

func percentEncode(value string) string {
	encoded := url.QueryEscape(value)
	encoded = strings.ReplaceAll(encoded, "+", "%20")
	encoded = strings.ReplaceAll(encoded, "*", "%2A")
	encoded = strings.ReplaceAll(encoded, "%7E", "~")
	return encoded
}

func canonicalQuery(params map[string]string) string {
	keys := make([]string, 0, len(params))
	for key := range params {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, percentEncode(key)+"="+percentEncode(params[key]))
	}
	return strings.Join(parts, "&")
}

func buildAliyunCreateTokenURL(accessKeyID, accessKeySecret, timestamp, nonce string) (string, string) {
	params := map[string]string{
		"AccessKeyId":      accessKeyID,
		"Action":           "CreateToken",
		"Format":           "JSON",
		"RegionId":         "cn-shanghai",
		"SignatureMethod":  "HMAC-SHA1",
		"SignatureNonce":   nonce,
		"SignatureVersion": "1.0",
		"Timestamp":        timestamp,
		"Version":          "2019-02-28",
	}
	query := canonicalQuery(params)
	stringToSign := "GET&" + percentEncode("/") + "&" + percentEncode(query)
	mac := hmac.New(sha1.New, []byte(accessKeySecret+"&"))
	_, _ = mac.Write([]byte(stringToSign))
	signature := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return aliyunTokenHost + "?" + query + "&Signature=" + percentEncode(signature), signature
}

func iso8601UTC(now time.Time) string {
	return now.UTC().Format("2006-01-02T15:04:05Z")
}

func randomNonce() string {
	var raw [16]byte
	_, _ = rand.Read(raw[:])
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:])
}

func createAliyunNLSToken(ctx context.Context, client HTTPDoer, accessKeyID, accessKeySecret string) (string, error) {
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	tokenURL, _ := buildAliyunCreateTokenURL(accessKeyID, accessKeySecret, iso8601UTC(time.Now()), randomNonce())
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, tokenURL, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<16))
	var payload struct {
		Code    string `json:"Code"`
		Message string `json:"Message"`
		Token   struct {
			ID string `json:"Id"`
		} `json:"Token"`
	}
	_ = json.Unmarshal(body, &payload)
	if response.StatusCode != http.StatusOK || strings.TrimSpace(payload.Token.ID) == "" {
		message := strings.TrimSpace(payload.Message)
		if message == "" {
			message = strings.TrimSpace(payload.Code)
		}
		if message == "" {
			message = fmt.Sprintf("ALIYUN_TOKEN_%d", response.StatusCode)
		}
		return "", fmt.Errorf("%s", message)
	}
	return strings.TrimSpace(payload.Token.ID), nil
}

func resolveAliyunToken(ctx context.Context, client HTTPDoer, accessKeyID, accessKeySecret, token string) (string, error) {
	if strings.TrimSpace(token) != "" {
		return strings.TrimSpace(token), nil
	}
	return createAliyunNLSToken(ctx, client, accessKeyID, accessKeySecret)
}

func probeAliyunSpeech(ctx context.Context, client HTTPDoer, record SpeechRecord, accessKeyID, accessKeySecret, token string, decryptErr error) SpeechTestResult {
	result := SpeechTestResult{Provider: SpeechProviderAliyun}
	if decryptErr != nil {
		result.Message = "阿里云语音密钥无法解密"
		return result
	}
	if !record.AliyunEnabled {
		result.Message = "阿里云语音已停用"
		return result
	}
	if strings.TrimSpace(record.AliyunAppKey) == "" {
		result.Message = "请填写阿里云 Appkey"
		return result
	}
	if strings.TrimSpace(token) == "" && (strings.TrimSpace(accessKeyID) == "" || strings.TrimSpace(accessKeySecret) == "") {
		result.Message = "请填写 AccessKey ID 和 Secret，或临时 Token"
		return result
	}
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	resolved, err := resolveAliyunToken(ctx, client, accessKeyID, accessKeySecret, token)
	if err != nil {
		if ctx.Err() != nil {
			result.Message = "阿里云 Token 连接超时"
			return result
		}
		result.Message = "阿里云鉴权失败，请检查 AccessKey"
		return result
	}
	gateway := strings.TrimRight(record.AliyunGateway, "/")
	if gateway == "" {
		gateway = defaultAliyunGate
	}
	voice := strings.TrimSpace(record.AliyunVoice)
	if voice == "" {
		voice = defaultAliyunVoice
	}
	body, _ := json.Marshal(map[string]any{
		"appkey":      strings.TrimSpace(record.AliyunAppKey),
		"text":        "测",
		"format":      "wav",
		"sample_rate": 16000,
		"voice":       voice,
	})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, gateway+"/stream/v1/tts", strings.NewReader(string(body)))
	if err != nil {
		result.Message = "无法连接阿里云语音"
		return result
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-NLS-Token", resolved)
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			result.Message = "阿里云语音连接超时"
			return result
		}
		result.Message = "无法连接阿里云语音"
		return result
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(response.Body, 1<<16))
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		result.Message = "阿里云语音鉴权失败，请检查 Appkey 或 Token"
		return result
	}
	if strings.Contains(contentType, "audio/") || (len(payload) >= 12 && string(payload[:4]) == "RIFF") {
		result.Reachable = true
		result.Message = "阿里云语音已连通"
		return result
	}
	if response.StatusCode >= 500 {
		result.Message = "阿里云语音暂时不可达"
		return result
	}
	result.Message = "阿里云语音鉴权可用，但合成未成功。请确认项目已开通语音合成并启用该音色。"
	return result
}
