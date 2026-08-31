package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/ai-interviewer/ai-powered/control-api/internal/settings"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/go-chi/chi/v5"
)

type voiceRoutesAdmin interface {
	ListVoiceRoutes(context.Context) ([]settings.VoiceRoute, error)
	GetVoiceRoute(context.Context, string) (settings.VoiceRoute, error)
	CreateVoiceRoute(context.Context, users.User, settings.VoiceRouteInput) (settings.VoiceRoute, error)
	UpdateVoiceRoute(context.Context, users.User, string, settings.VoiceRouteInput) (settings.VoiceRoute, error)
	DeleteVoiceRoute(context.Context, string) error
	ActivateVoiceRoute(context.Context, users.User, string) (settings.VoiceRoute, error)
	GetAgentVoiceRoute(context.Context) (settings.AgentVoiceRoute, error)
}

type voiceRoutesHandler struct{ admin voiceRoutesAdmin }

func (h voiceRoutesHandler) list(w http.ResponseWriter, r *http.Request) {
	routes, err := h.admin.ListVoiceRoutes(r.Context())
	if writeSettingsError(w, r, err) {
		writeJSON(w, http.StatusOK, routes)
	}
}

func (h voiceRoutesHandler) get(w http.ResponseWriter, r *http.Request) {
	route, err := h.admin.GetVoiceRoute(r.Context(), chi.URLParam(r, "id"))
	if writeSettingsError(w, r, err) {
		writeJSON(w, http.StatusOK, route)
	}
}

func (h voiceRoutesHandler) create(w http.ResponseWriter, r *http.Request) {
	actor, ok := requestActor(w, r)
	if !ok {
		return
	}
	var input settings.VoiceRouteInput
	if decodeBoundedJSON(w, r, &input) != nil {
		return
	}
	route, err := h.admin.CreateVoiceRoute(r.Context(), actor, input)
	if writeSettingsError(w, r, err) {
		writeJSON(w, http.StatusCreated, route)
	}
}

func (h voiceRoutesHandler) update(w http.ResponseWriter, r *http.Request) {
	actor, ok := requestActor(w, r)
	if !ok {
		return
	}
	var input settings.VoiceRouteInput
	if decodeBoundedJSON(w, r, &input) != nil {
		return
	}
	route, err := h.admin.UpdateVoiceRoute(r.Context(), actor, chi.URLParam(r, "id"), input)
	if writeSettingsError(w, r, err) {
		writeJSON(w, http.StatusOK, route)
	}
}

func (h voiceRoutesHandler) delete(w http.ResponseWriter, r *http.Request) {
	err := h.admin.DeleteVoiceRoute(r.Context(), chi.URLParam(r, "id"))
	if writeSettingsError(w, r, err) {
		w.WriteHeader(http.StatusNoContent)
	}
}

func (h voiceRoutesHandler) activate(w http.ResponseWriter, r *http.Request) {
	actor, ok := requestActor(w, r)
	if !ok {
		return
	}
	route, err := h.admin.ActivateVoiceRoute(r.Context(), actor, chi.URLParam(r, "id"))
	if writeSettingsError(w, r, err) {
		writeJSON(w, http.StatusOK, route)
	}
}

func (h voiceRoutesHandler) test(w http.ResponseWriter, r *http.Request) {
	route, err := h.admin.GetVoiceRoute(r.Context(), chi.URLParam(r, "id"))
	if !writeSettingsError(w, r, err) {
		return
	}
	if !route.Ready {
		writeAPIError(w, r, http.StatusConflict, "VOICE_ROUTE_NOT_READY", "线路模型未全部就绪")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ready": true, "message": "线路配置校验通过；实际媒体调用由 LiveKit Agent 会话验证"})
}

func (h voiceRoutesHandler) agent(w http.ResponseWriter, r *http.Request) {
	route, err := h.admin.GetAgentVoiceRoute(r.Context())
	if errors.Is(err, settings.ErrNotConfigured) || errors.Is(err, settings.ErrModelNotVerified) {
		writeAPIError(w, r, http.StatusConflict, "VOICE_ROUTE_NOT_READY", "active voice route is missing or not ready")
		return
	}
	if !writeSettingsError(w, r, err) {
		return
	}
	writeJSON(w, http.StatusOK, route)
}
