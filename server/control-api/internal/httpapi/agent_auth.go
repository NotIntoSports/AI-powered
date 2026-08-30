package httpapi

import (
	"net/http"
	"strings"
)

func requireAgentToken(expected string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.TrimSpace(expected) == "" {
				writeAPIError(w, r, http.StatusServiceUnavailable, "AGENT_AUTH_UNAVAILABLE", "agent internal token is not configured")
				return
			}
			auth := strings.TrimSpace(r.Header.Get("Authorization"))
			if !strings.HasPrefix(auth, "Bearer ") || strings.TrimSpace(strings.TrimPrefix(auth, "Bearer ")) != expected {
				writeAPIError(w, r, http.StatusUnauthorized, "UNAUTHORIZED", "invalid agent token")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
