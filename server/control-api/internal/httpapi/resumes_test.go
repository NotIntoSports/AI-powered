package httpapi

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/resumes"
	"github.com/ai-interviewer/ai-powered/control-api/internal/sessions"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
)

func TestClientResumesListIsScopedToCurrentUser(t *testing.T) {
	admin := &fakeResumeAdmin{records: []resumes.Record{sampleResume("resume-1")}}
	router := NewRouter(Dependencies{
		Authentication: desktopOperatorAuth(),
		ResumeAdmin:    admin,
	})
	response := performRequest(t, router, http.MethodGet, "/api/v1/client/resumes", "", map[string]string{
		"Authorization": "Bearer desktop-token",
	})
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if admin.listUserID != "op-1" {
		t.Fatalf("listUserID=%q", admin.listUserID)
	}
	assertNoStore(t, response)
}

func TestClientResumesDownloadAndDelete(t *testing.T) {
	admin := &fakeResumeAdmin{
		downloadURL: "https://example.cos.ap-guangzhou.myqcloud.com/resumes/a.pdf?sign=1",
	}
	router := NewRouter(Dependencies{
		Authentication: desktopOperatorAuth(),
		ResumeAdmin:    admin,
	})

	download := performRequest(t, router, http.MethodGet, "/api/v1/client/resumes/resume-1/download", "", map[string]string{
		"Authorization": "Bearer desktop-token",
	})
	if download.Code != http.StatusOK {
		t.Fatalf("download status=%d body=%s", download.Code, download.Body.String())
	}
	if admin.downloadActorID != "op-1" || admin.downloadID != "resume-1" {
		t.Fatalf("download actor=%s id=%s", admin.downloadActorID, admin.downloadID)
	}
	var body map[string]string
	decodeJSON(t, download, &body)
	if body["url"] != admin.downloadURL {
		t.Fatalf("url=%q", body["url"])
	}

	deleted := performRequest(t, router, http.MethodDelete, "/api/v1/client/resumes/resume-1", "", map[string]string{
		"Authorization": "Bearer desktop-token",
	})
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	if admin.deletedActorID != "op-1" || admin.deletedID != "resume-1" {
		t.Fatalf("delete actor=%s id=%s", admin.deletedActorID, admin.deletedID)
	}
}

func TestClientResumesDeleteNotFound(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: desktopOperatorAuth(),
		ResumeAdmin:    &fakeResumeAdmin{deleteErr: resumes.ErrNotFound},
	})
	response := performRequest(t, router, http.MethodDelete, "/api/v1/client/resumes/missing", "", map[string]string{
		"Authorization": "Bearer desktop-token",
	})
	assertAPIError(t, response, http.StatusNotFound, "RESUME_NOT_FOUND")
}

func TestAdminResumesDelete(t *testing.T) {
	admin := &fakeResumeAdmin{}
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		UserAdmin:      &fakeUserAdmin{},
		ResumeAdmin:    admin,
	})
	response := performAdminCookieRequest(t, router, http.MethodDelete, "/api/v1/admin/resumes/resume-1", "")
	if response.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if admin.deletedActorID != testUser.ID || admin.deletedID != "resume-1" {
		t.Fatalf("delete actor=%s id=%s", admin.deletedActorID, admin.deletedID)
	}
}

func TestAdminResumesListIsUnscoped(t *testing.T) {
	admin := &fakeResumeAdmin{records: []resumes.Record{sampleResume("resume-1")}}
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		UserAdmin:      &fakeUserAdmin{},
		ResumeAdmin:    admin,
	})
	response := performAdminCookieRequest(t, router, http.MethodGet, "/api/v1/admin/resumes", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if admin.listUserID != "" {
		t.Fatalf("admin list should not filter by uploader, got %q", admin.listUserID)
	}
}

func TestClientResumesRequireSession(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: &fakeAuthentication{},
		ResumeAdmin:    &fakeResumeAdmin{},
	})
	response := performRequest(t, router, http.MethodGet, "/api/v1/client/resumes", "", nil)
	assertAPIError(t, response, http.StatusUnauthorized, "UNAUTHENTICATED")
}

func desktopOperatorAuth() Authentication {
	return &fakeAuthentication{
		authenticate: func(rawToken, purpose string) (AuthenticatedSession, error) {
			if rawToken != "desktop-token" || purpose != sessions.PurposeDesktop {
				return AuthenticatedSession{}, ErrUnauthenticated
			}
			return AuthenticatedSession{
				User:     users.User{ID: "op-1", Username: "operator", Role: users.RoleOperator, Status: users.StatusActive},
				Session:  sessions.Session{ID: "session-desktop", UserID: "op-1", Purpose: sessions.PurposeDesktop},
				RawToken: rawToken,
			}, nil
		},
	}
}

func sampleResume(id string) resumes.Record {
	return resumes.Record{
		ID:               id,
		UploadedByUserID: "op-1",
		OriginalFilename: "cv.pdf",
		ContentType:      "application/pdf",
		SizeBytes:        1024,
		ObjectKey:        "resumes/" + id + "/cv.pdf",
		SHA256:           "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		CreatedAt:        time.Date(2026, 8, 16, 10, 0, 0, 0, time.UTC),
	}
}

type fakeResumeAdmin struct {
	records         []resumes.Record
	listUserID      string
	downloadURL     string
	downloadActorID string
	downloadID      string
	deletedActorID  string
	deletedID       string
	listErr         error
	downloadErr     error
	deleteErr       error
}

func (fake *fakeResumeAdmin) List(_ context.Context, uploadedByUserID string) ([]resumes.Record, error) {
	fake.listUserID = uploadedByUserID
	if fake.listErr != nil {
		return nil, fake.listErr
	}
	if fake.records == nil {
		return []resumes.Record{}, nil
	}
	return fake.records, nil
}

func (fake *fakeResumeAdmin) Upload(context.Context, users.User, string, resumes.UploadInput) (resumes.Record, error) {
	return resumes.Record{}, nil
}

func (fake *fakeResumeAdmin) DownloadURL(_ context.Context, actor users.User, id string) (string, resumes.Record, error) {
	fake.downloadActorID = actor.ID
	fake.downloadID = id
	if fake.downloadErr != nil {
		return "", resumes.Record{}, fake.downloadErr
	}
	return fake.downloadURL, sampleResume(id), nil
}

func (fake *fakeResumeAdmin) Delete(_ context.Context, actor users.User, _, id string) error {
	fake.deletedActorID = actor.ID
	fake.deletedID = id
	return fake.deleteErr
}

var _ ResumeAdmin = (*fakeResumeAdmin)(nil)
