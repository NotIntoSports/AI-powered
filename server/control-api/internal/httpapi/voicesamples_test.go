package httpapi

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ai-interviewer/ai-powered/control-api/internal/voicesamples"
)

type fakeVoiceSampleAdmin struct {
	uploadResult voicesamples.UploadResult
	uploadErr    error
	deleteErr    error
}

func (fake *fakeVoiceSampleAdmin) Upload(context.Context, io.Reader) (voicesamples.UploadResult, error) {
	return fake.uploadResult, fake.uploadErr
}

func (fake *fakeVoiceSampleAdmin) Delete(context.Context, string) error { return fake.deleteErr }

func voiceSampleMultipart(t *testing.T) (*bytes.Buffer, string) {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", "voice.wav")
	if err != nil {
		t.Fatal(err)
	}
	payload := make([]byte, 64)
	copy(payload[0:4], "RIFF")
	copy(payload[8:12], "WAVE")
	if _, err := part.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return body, writer.FormDataContentType()
}

func performVoiceSampleUpload(t *testing.T, admin VoiceSampleAdmin, authenticated bool) *httptest.ResponseRecorder {
	t.Helper()
	body, contentType := voiceSampleMultipart(t)
	var auth Authentication = &fakeAuthentication{}
	headers := map[string]string{"Content-Type": contentType}
	if authenticated {
		auth = desktopOperatorAuth()
		headers["Authorization"] = "Bearer desktop-token"
	}
	router := NewRouter(Dependencies{Authentication: auth, VoiceSampleAdmin: admin})
	return performRequest(t, router, http.MethodPost, "/api/v1/client/voice-samples", body.String(), headers)
}

func TestVoiceSampleUploadRequiresSession(t *testing.T) {
	response := performVoiceSampleUpload(t, &fakeVoiceSampleAdmin{}, false)
	assertAPIError(t, response, http.StatusUnauthorized, "UNAUTHENTICATED")
}

func TestVoiceSampleUploadReturnsCreated(t *testing.T) {
	admin := &fakeVoiceSampleAdmin{uploadResult: voicesamples.UploadResult{ID: "id", URL: "https://example.invalid", SizeBytes: 64, ExpiresIn: 1800}}
	response := performVoiceSampleUpload(t, admin, true)
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestVoiceSampleUploadMapsSafeErrors(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{voicesamples.ErrUnsupported, http.StatusUnprocessableEntity, "UNSUPPORTED_TYPE"},
		{voicesamples.ErrNotConfigured, http.StatusServiceUnavailable, "STORAGE_UNCONFIGURED"},
		{voicesamples.ErrStore, http.StatusInternalServerError, "VOICE_SAMPLE_STORAGE_ACCESS_FAILED"},
		{voicesamples.ErrUpload, http.StatusInternalServerError, "VOICE_SAMPLE_UPLOAD_FAILED"},
		{voicesamples.ErrPresign, http.StatusInternalServerError, "VOICE_SAMPLE_PRESIGN_FAILED"},
	}
	for _, item := range cases {
		t.Run(item.code, func(t *testing.T) {
			response := performVoiceSampleUpload(t, &fakeVoiceSampleAdmin{uploadErr: item.err}, true)
			assertAPIError(t, response, item.status, item.code)
		})
	}
}

func TestVoiceSampleDeleteReturnsNoContentAndClassifiesFailure(t *testing.T) {
	router := NewRouter(Dependencies{Authentication: desktopOperatorAuth(), VoiceSampleAdmin: &fakeVoiceSampleAdmin{}})
	ok := performRequest(t, router, http.MethodDelete, "/api/v1/client/voice-samples/0123456789abcdef0123456789abcdef", "", map[string]string{"Authorization": "Bearer desktop-token"})
	if ok.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", ok.Code, ok.Body.String())
	}

	router = NewRouter(Dependencies{Authentication: desktopOperatorAuth(), VoiceSampleAdmin: &fakeVoiceSampleAdmin{deleteErr: errors.New("delete")}})
	failed := performRequest(t, router, http.MethodDelete, "/api/v1/client/voice-samples/0123456789abcdef0123456789abcdef", "", map[string]string{"Authorization": "Bearer desktop-token"})
	assertAPIError(t, failed, http.StatusInternalServerError, "VOICE_SAMPLE_DELETE_FAILED")
}
