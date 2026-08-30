package httpapi

import (
	"encoding/json"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/ratelimit"
	"github.com/ai-interviewer/ai-powered/control-api/internal/sessions"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type Dependencies struct {
	Authentication     Authentication
	UserAdmin          UserAdmin
	SettingsAdmin      SettingsAdmin
	PresenceAdmin      PresenceAdmin
	ResumeAdmin        ResumeAdmin
	KnowledgeAdmin     KnowledgeAdmin
	VoiceSampleAdmin   VoiceSampleAdmin
	LoginLimiter       *ratelimit.LoginLimiter
	SessionTTL         time.Duration
	CookieSecure       bool
	TrustedProxyCIDRs  []netip.Prefix
	AgentInternalToken string
}

func NewRouter(dependencies Dependencies) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(2 * time.Minute))
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
		adminUsers := newAdminUsersHandler(dependencies.UserAdmin, dependencies.PresenceAdmin, dependencies.SettingsAdmin)
		r.Route("/api/v1/admin", func(r chi.Router) {
			r.Use(noStore)
			r.Use(authentication.loadSession)
			r.Use(func(next http.Handler) http.Handler {
				return RequireSession(sessions.PurposeBrowser, next)
			})
			r.Use(requireAdministrator)
			r.Route("/users", func(r chi.Router) {
				r.Get("/", adminUsers.list)
				r.Post("/", adminUsers.create)
				r.Patch("/{id}", adminUsers.patch)
				r.Post("/{id}/reset-password", adminUsers.resetPassword)
				r.Post("/{id}/revoke-sessions", adminUsers.revokeSessions)
				if dependencies.SettingsAdmin != nil {
					r.Delete("/{id}/voice", adminUsers.deleteVoice)
				}
			})
			if dependencies.PresenceAdmin != nil {
				adminPresence := newAdminPresenceHandler(dependencies.PresenceAdmin)
				r.Get("/sessions", adminPresence.listLines)
				r.Get("/devices", adminPresence.listDevices)
			}
			if dependencies.SettingsAdmin != nil {
				adminSettings := newAdminSettingsHandler(dependencies.SettingsAdmin)
				r.Route("/settings", func(r chi.Router) {
					r.Get("/ai", adminSettings.getAI)
					r.Put("/ai", adminSettings.putAI)
					r.Post("/ai/test", adminSettings.testAI)
					r.Get("/rtc", adminSettings.getRTC)
					r.Put("/rtc", adminSettings.putRTC)
					r.Post("/rtc/test", adminSettings.testRTC)
					r.Get("/storage", adminSettings.getStorage)
					r.Put("/storage", adminSettings.putStorage)
					r.Post("/storage/test", adminSettings.testStorage)
					r.Get("/speech", adminSettings.getSpeech)
					r.Put("/speech", adminSettings.putSpeech)
					r.Post("/speech/test", adminSettings.testSpeech)
					r.Post("/speech/preview", adminSettings.previewSpeech)
					r.Post("/speech/asr-test", adminSettings.testSpeechASR)
					r.Get("/speech/voices", adminSettings.listSpeechVoices)
					r.Get("/pipeline", adminSettings.getPipeline)
					r.Put("/pipeline", adminSettings.putPipeline)
					r.Get("/roles", adminSettings.getRoles)
					r.Put("/roles", adminSettings.putRoles)
				})
			}
			if dependencies.ResumeAdmin != nil {
				resumeAdmin := newResumeHandler(dependencies.ResumeAdmin, dependencies.KnowledgeAdmin)
				r.Get("/resumes", resumeAdmin.list)
				r.Post("/resumes", resumeAdmin.upload)
				r.Get("/resumes/{id}/download", resumeAdmin.download)
				r.Delete("/resumes/{id}", resumeAdmin.delete)
				if dependencies.KnowledgeAdmin != nil {
					knowledgeAdmin := newKnowledgeHandler(dependencies.KnowledgeAdmin)
					r.Post("/resumes/{id}/reindex", knowledgeAdmin.reindex)
				}
			}
		})
	}

	if dependencies.ResumeAdmin != nil || dependencies.SettingsAdmin != nil || dependencies.VoiceSampleAdmin != nil {
		r.Route("/api/v1/client", func(r chi.Router) {
			r.Use(noStore)
			r.Use(authentication.loadSession)
			r.Use(requireAnySession)
			if dependencies.ResumeAdmin != nil {
				clientResumes := newResumeHandler(dependencies.ResumeAdmin, dependencies.KnowledgeAdmin)
				r.Get("/resumes", clientResumes.listMine)
				r.Post("/resumes", clientResumes.upload)
				r.Get("/resumes/{id}/download", clientResumes.download)
				r.Delete("/resumes/{id}", clientResumes.delete)
				if dependencies.KnowledgeAdmin != nil {
					clientKnowledge := newKnowledgeHandler(dependencies.KnowledgeAdmin)
					r.Get("/resumes/{id}/status", clientKnowledge.status)
					r.Post("/knowledge/search", clientKnowledge.search)
				}
			}
			if dependencies.SettingsAdmin != nil {
				clientSettings := newAdminSettingsHandler(dependencies.SettingsAdmin)
				r.Get("/settings/ai", clientSettings.getClientAI)
				r.Get("/settings/asr", clientSettings.getClientASR)
				r.Get("/settings/speech", clientSettings.getClientSpeech)
				r.Patch("/settings/speech", clientSettings.patchClientSpeech)
				r.Post("/rtc/token", clientSettings.issueRTC)
				r.Get("/settings/roles", clientSettings.getClientRoles)
				r.Get("/settings/pipeline", clientSettings.getClientPipeline)
			}
			if dependencies.VoiceSampleAdmin != nil {
				clientVoiceSamples := newVoiceSampleHandler(dependencies.VoiceSampleAdmin)
				r.Post("/voice-samples", clientVoiceSamples.upload)
				r.Delete("/voice-samples/{id}", clientVoiceSamples.delete)
			}
		})
	}

	if dependencies.SettingsAdmin != nil && strings.TrimSpace(dependencies.AgentInternalToken) != "" {
		agentSettings := newAdminSettingsHandler(dependencies.SettingsAdmin)
		r.Route("/api/v1/agent", func(r chi.Router) {
			r.Use(noStore)
			r.Use(requireAgentToken(dependencies.AgentInternalToken))
			r.Get("/settings/speech", agentSettings.getAgentSpeech)
			r.Get("/settings/pipeline", agentSettings.getAgentPipeline)
			r.Get("/settings/ai", agentSettings.getAgentAI)
		})
	}

	return r
}
