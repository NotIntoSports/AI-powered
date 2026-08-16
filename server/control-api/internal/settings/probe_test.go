package settings

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) Do(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestProbeAIFindsConfiguredModelAndDoesNotEchoKey(t *testing.T) {
	var sawAuth string
	client := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		sawAuth = request.Header.Get("Authorization")
		body := `{"data":[{"id":"gpt-4o-mini"},{"id":"other"}]}`
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(body)),
			Header:     make(http.Header),
		}, nil
	})
	result := ProbeAI(context.Background(), client, "https://api.openai.com/v1", "sk-secret", "gpt-4o-mini")
	if !result.Reachable || !result.ModelFound || sawAuth != "Bearer sk-secret" {
		t.Fatalf("result=%#v auth=%q", result, sawAuth)
	}
	if strings.Contains(strings.ToLower(result.Message), "sk-secret") {
		t.Fatalf("message leaked key: %s", result.Message)
	}
}

func TestProbeAIReportsMissingModelWithoutUpstreamBody(t *testing.T) {
	client := roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"data":[{"id":"other"}]}`)),
			Header:     make(http.Header),
		}, nil
	})
	result := ProbeAI(context.Background(), client, "https://api.openai.com/v1", "", "missing")
	if !result.Reachable || result.ModelFound {
		t.Fatalf("result=%#v", result)
	}
}

func TestProbeSpeechUsesApiKeyAndTreatsUnauthorizedAsAuthFailure(t *testing.T) {
	var sawKey, sawApp, sawToken string
	client := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		sawKey = request.Header.Get("X-Api-Key")
		sawApp = request.Header.Get("X-Api-App-Key")
		sawToken = request.Header.Get("X-Api-Access-Key")
		return &http.Response{
			StatusCode: http.StatusUnauthorized,
			Body:       io.NopCloser(strings.NewReader(`{"message":"unauthorized"}`)),
			Header:     make(http.Header),
		}, nil
	})
	record := SpeechRecord{Enabled: true, EncryptedAPIKey: []byte("pending"), SpeakerID: "custom_zh_interviewer"}
	result := ProbeSpeech(context.Background(), client, record, "volc-secret-key", "", nil)
	if result.Reachable || sawKey != "volc-secret-key" || sawApp != "" || sawToken != "" {
		t.Fatalf("result=%#v key=%q app=%q token=%q", result, sawKey, sawApp, sawToken)
	}
	if strings.Contains(result.Message, "volc-secret-key") {
		t.Fatalf("message leaked key: %s", result.Message)
	}
}

func TestProbeSpeechFallsBackToAppIdToken(t *testing.T) {
	var sawKey, sawApp, sawToken string
	client := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		sawKey = request.Header.Get("X-Api-Key")
		sawApp = request.Header.Get("X-Api-App-Key")
		sawToken = request.Header.Get("X-Api-Access-Key")
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"status":0}`)),
			Header:     make(http.Header),
		}, nil
	})
	record := SpeechRecord{Enabled: true, AppID: "8358554445", EncryptedAccessToken: []byte("pending")}
	result := ProbeSpeech(context.Background(), client, record, "", "volc-access-token", nil)
	if !result.Reachable || sawKey != "" || sawApp != "8358554445" || sawToken != "volc-access-token" {
		t.Fatalf("result=%#v key=%q app=%q token=%q", result, sawKey, sawApp, sawToken)
	}
}

func TestProbeLiveKitTreatsHTTPResponseAsReachable(t *testing.T) {
	client := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Scheme != "http" || request.URL.Host != "127.0.0.1:7880" {
			t.Fatalf("url=%s", request.URL.String())
		}
		return &http.Response{
			StatusCode: http.StatusNotFound,
			Body:       io.NopCloser(strings.NewReader("")),
			Header:     make(http.Header),
		}, nil
	})
	result := ProbeLiveKit(context.Background(), client, "ws://127.0.0.1:7880")
	if !result.Reachable || result.Provider != ProviderLiveKit {
		t.Fatalf("result=%#v", result)
	}
}
