package httpapi

import (
	"net/http"
	"strings"

	"github.com/ai-interviewer/ai-powered/control-api/internal/settings"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type aiProviderSettingsRequest struct {
	Name              string `json:"name"`
	Provider          string `json:"provider"`
	BaseURL           string `json:"baseUrl"`
	Model             string `json:"model"`
	QuestionTimeoutMs int    `json:"questionTimeoutMs"`
	ReportTimeoutMs   int    `json:"reportTimeoutMs"`
	Enabled           *bool  `json:"enabled"`
	APIKey            string `json:"apiKey"`
	ClearAPIKey       bool   `json:"clearApiKey"`
}

type aiProviderModelRequest struct {
	ModelID         string `json:"modelId"`
	OwnedBy         string `json:"ownedBy"`
	Enabled         *bool  `json:"enabled"`
	RealtimeEnabled *bool  `json:"realtimeEnabled"`
	Reverify        bool   `json:"reverify"`
}

func aiProviderInputFromRequest(input aiProviderSettingsRequest) settings.AIProviderInput {
	return settings.AIProviderInput{
		Name:              input.Name,
		Provider:          input.Provider,
		BaseURL:           input.BaseURL,
		Model:             input.Model,
		QuestionTimeoutMs: input.QuestionTimeoutMs,
		ReportTimeoutMs:   input.ReportTimeoutMs,
		Enabled:           input.Enabled,
		APIKey:            input.APIKey,
		ClearAPIKey:       input.ClearAPIKey,
	}
}

func (handler *adminSettingsHandler) listAIProviders(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	providers, err := handler.admin.ListAIProviders(request.Context())
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, providers)
}

func (handler *adminSettingsHandler) createAIProvider(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	input := aiProviderSettingsRequest{}
	if err := decodeBoundedJSON(w, request, &input); err != nil {
		writeJSONDecodeError(w, request, err)
		return
	}
	public, err := handler.admin.CreateAIProvider(request.Context(), actor, middleware.GetReqID(request.Context()), aiProviderInputFromRequest(input))
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusCreated, public)
}

func (handler *adminSettingsHandler) getAIProvider(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	public, err := handler.admin.GetAIProvider(request.Context(), chi.URLParam(request, "id"))
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, public)
}

func (handler *adminSettingsHandler) putAIProvider(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	input := aiProviderSettingsRequest{}
	if err := decodeBoundedJSON(w, request, &input); err != nil {
		writeJSONDecodeError(w, request, err)
		return
	}
	public, err := handler.admin.UpdateAIProvider(request.Context(), actor, middleware.GetReqID(request.Context()), chi.URLParam(request, "id"), aiProviderInputFromRequest(input))
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, public)
}

func (handler *adminSettingsHandler) deleteAIProvider(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	err := handler.admin.DeleteAIProvider(request.Context(), actor, middleware.GetReqID(request.Context()), chi.URLParam(request, "id"))
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (handler *adminSettingsHandler) activateAIProvider(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	public, err := handler.admin.ActivateAIProvider(request.Context(), actor, middleware.GetReqID(request.Context()), chi.URLParam(request, "id"))
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, public)
}

func (handler *adminSettingsHandler) testAIProvider(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	var payload *settings.AIProviderInput
	if request.Body != nil && request.ContentLength != 0 {
		input := aiProviderSettingsRequest{}
		if err := decodeBoundedJSON(w, request, &input); err != nil {
			writeJSONDecodeError(w, request, err)
			return
		}
		converted := aiProviderInputFromRequest(input)
		payload = &converted
	}
	result, err := handler.admin.TestAIProvider(request.Context(), actor, middleware.GetReqID(request.Context()), chi.URLParam(request, "id"), payload)
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (handler *adminSettingsHandler) discoverAIProviderModels(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	var draft *settings.AIProviderInput
	if request.Body != nil && request.ContentLength != 0 {
		input := aiProviderSettingsRequest{}
		if err := decodeBoundedJSON(w, request, &input); err != nil {
			writeJSONDecodeError(w, request, err)
			return
		}
		converted := aiProviderInputFromRequest(input)
		draft = &converted
	}
	models, err := handler.admin.DiscoverProviderModels(request.Context(), chi.URLParam(request, "id"), draft)
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, models)
}

func (handler *adminSettingsHandler) listAIProviderModels(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	models, err := handler.admin.ListProviderModels(request.Context(), chi.URLParam(request, "id"))
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, models)
}

func (handler *adminSettingsHandler) createAIProviderModel(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	input := aiProviderModelRequest{}
	if err := decodeBoundedJSON(w, request, &input); err != nil {
		writeJSONDecodeError(w, request, err)
		return
	}
	model, err := handler.admin.AddProviderModel(request.Context(), chi.URLParam(request, "id"), strings.TrimSpace(input.ModelID), strings.TrimSpace(input.OwnedBy))
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusCreated, model)
}

func (handler *adminSettingsHandler) deleteAIProviderModel(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	err := handler.admin.DeleteProviderModel(request.Context(), chi.URLParam(request, "id"), chi.URLParam(request, "modelId"))
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (handler *adminSettingsHandler) patchAIProviderModel(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	input := aiProviderModelRequest{}
	if err := decodeBoundedJSON(w, request, &input); err != nil {
		writeJSONDecodeError(w, request, err)
		return
	}
	if input.Enabled == nil && input.RealtimeEnabled == nil {
		writeAPIError(w, request, http.StatusUnprocessableEntity, "INVALID_INPUT", "enabled or realtimeEnabled is required")
		return
	}
	if input.Enabled != nil {
		err := handler.admin.SetProviderModelEnabled(request.Context(), chi.URLParam(request, "id"), chi.URLParam(request, "modelId"), *input.Enabled)
		if !writeSettingsError(w, request, err) {
			return
		}
	}
	if input.RealtimeEnabled != nil {
		model, err := handler.admin.SetProviderModelRealtime(request.Context(), chi.URLParam(request, "id"), chi.URLParam(request, "modelId"), *input.RealtimeEnabled, input.Reverify)
		if !writeSettingsError(w, request, err) {
			return
		}
		writeJSON(w, http.StatusOK, model)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (handler *adminSettingsHandler) activateAIProviderModel(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	public, err := handler.admin.ActivateProviderModel(request.Context(), actor, middleware.GetReqID(request.Context()), chi.URLParam(request, "id"), chi.URLParam(request, "modelId"))
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, public)
}

func (handler *adminSettingsHandler) verifyAIProviderModel(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	result, err := handler.admin.VerifyTokenPlanModel(request.Context(), chi.URLParam(request, "id"), chi.URLParam(request, "modelId"))
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (handler *adminSettingsHandler) syncOfficialTokenPlanCatalog(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	result, err := handler.admin.SyncOfficialTokenPlanCatalog(request.Context())
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, result)
}
