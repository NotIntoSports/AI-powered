package httpapi

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/ai-interviewer/ai-powered/control-api/internal/voicesamples"
	"github.com/go-chi/chi/v5"
)

type VoiceSampleAdmin interface {
	Upload(ctx context.Context, body io.Reader) (voicesamples.UploadResult, error)
	Delete(ctx context.Context, id string) error
}

type voiceSampleHandler struct {
	admin VoiceSampleAdmin
}

func newVoiceSampleHandler(admin VoiceSampleAdmin) *voiceSampleHandler {
	return &voiceSampleHandler{admin: admin}
}

func (handler *voiceSampleHandler) upload(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	request.Body = http.MaxBytesReader(w, request.Body, voicesamples.MaxBytes+1024*1024)
	if err := request.ParseMultipartForm(voicesamples.MaxBytes); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeAPIError(w, request, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "voice sample must be 10MB or smaller")
			return
		}
		writeAPIError(w, request, http.StatusBadRequest, "INVALID_INPUT", "multipart form is required")
		return
	}
	file, _, err := request.FormFile("file")
	if err != nil {
		writeAPIError(w, request, http.StatusUnprocessableEntity, "INVALID_INPUT", "voice sample file is required")
		return
	}
	defer file.Close()
	result, err := handler.admin.Upload(request.Context(), file)
	if !writeVoiceSampleError(w, request, "upload", err) {
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (handler *voiceSampleHandler) delete(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	id := strings.TrimSpace(chi.URLParam(request, "id"))
	if !writeVoiceSampleError(w, request, "delete", handler.admin.Delete(request.Context(), id)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeVoiceSampleError(w http.ResponseWriter, request *http.Request, operation string, err error) bool {
	if err == nil {
		return true
	}
	switch {
	case errors.Is(err, voicesamples.ErrInvalidInput):
		writeAPIError(w, request, http.StatusUnprocessableEntity, "INVALID_INPUT", err.Error())
	case errors.Is(err, voicesamples.ErrTooLarge):
		writeAPIError(w, request, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", err.Error())
	case errors.Is(err, voicesamples.ErrUnsupported):
		writeAPIError(w, request, http.StatusUnprocessableEntity, "UNSUPPORTED_TYPE", "voice sample must be a WAV file")
	case errors.Is(err, voicesamples.ErrNotConfigured):
		writeAPIError(w, request, http.StatusServiceUnavailable, "STORAGE_UNCONFIGURED", "object storage is not configured")
	case errors.Is(err, voicesamples.ErrStore):
		log.Printf("voice_sample operation=%s status=failed code=VOICE_SAMPLE_STORAGE_ACCESS_FAILED", operation)
		writeAPIError(w, request, http.StatusInternalServerError, "VOICE_SAMPLE_STORAGE_ACCESS_FAILED", "unable to access object storage settings")
	case errors.Is(err, voicesamples.ErrUpload):
		log.Printf("voice_sample operation=%s status=failed code=VOICE_SAMPLE_UPLOAD_FAILED", operation)
		writeAPIError(w, request, http.StatusInternalServerError, "VOICE_SAMPLE_UPLOAD_FAILED", "unable to upload voice sample")
	case errors.Is(err, voicesamples.ErrPresign):
		log.Printf("voice_sample operation=%s status=failed code=VOICE_SAMPLE_PRESIGN_FAILED", operation)
		writeAPIError(w, request, http.StatusInternalServerError, "VOICE_SAMPLE_PRESIGN_FAILED", "unable to create voice sample URL")
	case errors.Is(err, voicesamples.ErrDelete):
		log.Printf("voice_sample operation=%s status=failed code=VOICE_SAMPLE_DELETE_FAILED", operation)
		writeAPIError(w, request, http.StatusInternalServerError, "VOICE_SAMPLE_DELETE_FAILED", "unable to delete voice sample")
	default:
		code := "VOICE_SAMPLE_UPLOAD_FAILED"
		message := "unable to upload voice sample"
		if operation == "delete" {
			code = "VOICE_SAMPLE_DELETE_FAILED"
			message = "unable to delete voice sample"
		}
		log.Printf("voice_sample operation=%s status=failed code=%s", operation, code)
		writeAPIError(w, request, http.StatusInternalServerError, code, message)
	}
	return false
}
