package settings

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestAliyunCreateTokenSignatureMatchesOfficialEncoding(t *testing.T) {
	_, signature := buildAliyunCreateTokenURL(
		"LTAItestkey",
		"testsecret",
		"2019-04-03T06:15:03Z",
		"8d1e6a7a-f44e-40d5-aedb-fe4a1c80f434",
	)
	if signature != "KjcxMs8/vyjkFEh3OCW/VaUzv7o=" {
		t.Fatalf("signature=%q", signature)
	}
}

func TestValidAliyunVoiceAcceptsXiaoyun(t *testing.T) {
	if !validAliyunVoice("xiaoyun") || !validAliyunGateway(defaultAliyunGate) {
		t.Fatal("expected default Aliyun voice and gateway to be valid")
	}
	if validAliyunVoice("x") || validAliyunGateway("http://example.com") {
		t.Fatal("expected invalid Aliyun values to be rejected")
	}
}

func TestProbeAliyunSpeechUsesTokenHeader(t *testing.T) {
	var sawToken, sawHost string
	client := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		sawHost = request.URL.Host
		if strings.Contains(request.URL.Host, "nls-meta") {
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(`{"Token":{"Id":"nls-token","ExpireTime":4102444800}}`)),
				Header:     make(http.Header),
			}, nil
		}
		sawToken = request.Header.Get("X-NLS-Token")
		header := make(http.Header)
		header.Set("Content-Type", "audio/wav")
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader("RIFF" + strings.Repeat("x", 12) + "WAVE")),
			Header:     header,
		}, nil
	})
	record := SpeechRecord{
		AliyunEnabled: true,
		AliyunAppKey:  "FeBrZpfg4YaDM9DL",
		AliyunVoice:   "xiaoyun",
		AliyunGateway: defaultAliyunGate,
	}
	result := probeAliyunSpeech(context.Background(), client, record, "ak-id", "ak-secret", "", nil)
	if !result.Reachable || sawToken != "nls-token" || !strings.Contains(sawHost, "nls-gateway") {
		t.Fatalf("result=%#v token=%q host=%q", result, sawToken, sawHost)
	}
	if strings.Contains(result.Message, "ak-secret") {
		t.Fatalf("message leaked secret: %s", result.Message)
	}
}
