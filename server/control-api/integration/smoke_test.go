package integration

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

const (
	sessionCookieName = "control_session"
	healthWait        = 30 * time.Second
	healthPoll        = 250 * time.Millisecond
)

func TestSmoke(t *testing.T) {
	baseURL := strings.TrimRight(os.Getenv("CONTROL_API_URL"), "/")
	if baseURL == "" {
		t.Skip("CONTROL_API_URL is unset; skipping container smoke test")
	}
	username := os.Getenv("CONTROL_API_USERNAME")
	password := os.Getenv("CONTROL_API_PASSWORD")
	if username == "" || password == "" {
		t.Fatal("CONTROL_API_USERNAME and CONTROL_API_PASSWORD are required when CONTROL_API_URL is set")
	}

	client := &http.Client{Timeout: 5 * time.Second}
	waitForHealth(t, client, baseURL)

	loginBody, err := json.Marshal(map[string]string{
		"username": username,
		"password": password,
		"purpose":  "browser",
	})
	if err != nil {
		t.Fatalf("encode login request: %v", err)
	}

	loginResponse := mustDo(t, client, newJSONRequest(t, http.MethodPost, baseURL+"/api/v1/auth/login", loginBody))
	defer loginResponse.Body.Close()
	if loginResponse.StatusCode != http.StatusOK {
		t.Fatalf("login status=%d", loginResponse.StatusCode)
	}
	sessionCookie := sessionCookieFrom(loginResponse)
	if sessionCookie == nil {
		t.Fatal("login did not set a browser session cookie")
	}

	meResponse := mustDo(t, client, requestWithCookie(t, http.MethodGet, baseURL+"/api/v1/auth/me", nil, sessionCookie))
	defer meResponse.Body.Close()
	if meResponse.StatusCode != http.StatusOK {
		t.Fatalf("me status=%d", meResponse.StatusCode)
	}
	var me struct {
		Username string `json:"username"`
	}
	if err := json.NewDecoder(meResponse.Body).Decode(&me); err != nil {
		t.Fatalf("decode me response: %v", err)
	}
	if !strings.EqualFold(me.Username, username) {
		t.Fatalf("me username %q does not match requested administrator", me.Username)
	}

	logoutResponse := mustDo(t, client, requestWithCookie(t, http.MethodPost, baseURL+"/api/v1/auth/logout", nil, sessionCookie))
	defer logoutResponse.Body.Close()
	if logoutResponse.StatusCode != http.StatusNoContent {
		t.Fatalf("logout status=%d", logoutResponse.StatusCode)
	}

	reused := mustDo(t, client, requestWithCookie(t, http.MethodGet, baseURL+"/api/v1/auth/me", nil, sessionCookie))
	defer reused.Body.Close()
	if reused.StatusCode != http.StatusUnauthorized {
		t.Fatalf("reused session status=%d, want 401", reused.StatusCode)
	}
}

func waitForHealth(t *testing.T, client *http.Client, baseURL string) {
	t.Helper()
	deadline := time.Now().Add(healthWait)
	var lastStatus int
	var lastErr error
	for {
		response, err := client.Get(baseURL + "/healthz")
		if err == nil {
			lastStatus = response.StatusCode
			if response.StatusCode == http.StatusOK {
				var health struct {
					Service string `json:"service"`
					Status  string `json:"status"`
				}
				decodeErr := json.NewDecoder(response.Body).Decode(&health)
				response.Body.Close()
				if decodeErr == nil && health.Service == "control-api" && health.Status == "ok" {
					return
				}
				lastErr = decodeErr
			} else {
				io.Copy(io.Discard, response.Body)
				response.Body.Close()
			}
		} else {
			lastErr = err
		}
		if time.Now().After(deadline) {
			if lastErr != nil {
				t.Fatalf("healthz not ready within %s", healthWait)
			}
			t.Fatalf("healthz status=%d, want control-api ok", lastStatus)
		}
		time.Sleep(healthPoll)
	}
}

func newJSONRequest(t *testing.T, method, url string, body []byte) *http.Request {
	t.Helper()
	request, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	return request
}

func requestWithCookie(t *testing.T, method, url string, body []byte, cookie *http.Cookie) *http.Request {
	t.Helper()
	request := newJSONRequest(t, method, url, body)
	request.AddCookie(cookie)
	return request
}

func mustDo(t *testing.T, client *http.Client, request *http.Request) *http.Response {
	t.Helper()
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("%s %s: request failed", request.Method, request.URL.Path)
	}
	return response
}

func sessionCookieFrom(response *http.Response) *http.Cookie {
	for _, cookie := range response.Cookies() {
		if cookie.Name == sessionCookieName && cookie.Value != "" {
			clone := *cookie
			return &clone
		}
	}
	return nil
}
