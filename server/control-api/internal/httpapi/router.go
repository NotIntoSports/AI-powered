package httpapi

import (
	"encoding/json"
	"net/http"
	"net/netip"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/ratelimit"
	"github.com/ai-interviewer/ai-powered/control-api/internal/sessions"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type Dependencies struct {
	Authentication    Authentication
	UserAdmin         UserAdmin
	LoginLimiter      *ratelimit.LoginLimiter
	SessionTTL        time.Duration
	CookieSecure      bool
	TrustedProxyCIDRs []netip.Prefix
}

func NewRouter(dependencies Dependencies) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			next.ServeHTTP(w, req)
		})
	})
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			Service string `json:"service"`
			Status  string `json:"status"`
		}{
			Service: "control-api",
			Status:  "ok",
		})
	})

	authentication := newAuthHandler(dependencies)
	r.Route("/api/v1/auth", func(r chi.Router) {
		r.Use(noStore)
		r.Post("/login", authentication.login)
		r.Group(func(r chi.Router) {
			r.Use(authentication.loadSession)
			r.With(requireAnySession).Post("/logout", authentication.logout)
			r.With(requireAnySession).Get("/me", authentication.me)
		})
	})

	if dependencies.UserAdmin != nil {
		adminUsers := newAdminUsersHandler(dependencies.UserAdmin)
		r.Route("/api/v1/admin/users", func(r chi.Router) {
			r.Use(noStore)
			r.Use(authentication.loadSession)
			r.Use(func(next http.Handler) http.Handler {
				return RequireSession(sessions.PurposeBrowser, next)
			})
			r.Use(requireAdministrator)
			r.Get("/", adminUsers.list)
			r.Post("/", adminUsers.create)
			r.Patch("/{id}", adminUsers.patch)
			r.Post("/{id}/reset-password", adminUsers.resetPassword)
			r.Post("/{id}/revoke-sessions", adminUsers.revokeSessions)
		})
	}

	return r
}
