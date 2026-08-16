package httpapi

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/presence"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
)

type fakePresenceAdmin struct {
	users map[string]presence.UserPresence
	lines []presence.Line
}

func (fake *fakePresenceAdmin) ListUserPresence(context.Context) (map[string]presence.UserPresence, error) {
	return fake.users, nil
}

func (fake *fakePresenceAdmin) ListLines(context.Context) ([]presence.Line, error) {
	return fake.lines, nil
}

func (fake *fakePresenceAdmin) ListDevices(context.Context) ([]presence.Device, error) {
	return []presence.Device{}, nil
}

func TestAdminUsersListIncludesOnlinePresence(t *testing.T) {
	now := time.Now().UTC()
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		UserAdmin: &fakeUserAdmin{
			list: func(users.User) ([]users.User, error) { return []users.User{testUser}, nil },
		},
		PresenceAdmin: &fakePresenceAdmin{
			users: map[string]presence.UserPresence{
				testUser.ID: {UserID: testUser.ID, LastSeenAt: &now, ActiveSessionCount: 1, Online: true},
			},
			lines: []presence.Line{{
				ID: "sess-1", UserID: testUser.ID, Username: testUser.Username, Purpose: "browser", CreatedAt: now, ExpiresAt: now.Add(time.Hour), Online: true,
			}},
		},
	})
	list := performAdminCookieRequest(t, router, http.MethodGet, "/api/v1/admin/users", "")
	if list.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", list.Code, list.Body.String())
	}
	var usersListed []adminUser
	decodeJSON(t, list, &usersListed)
	if len(usersListed) != 1 || !usersListed[0].Online || usersListed[0].ActiveSessionCount != 1 {
		t.Fatalf("listed=%#v", usersListed)
	}

	lines := performAdminCookieRequest(t, router, http.MethodGet, "/api/v1/admin/sessions", "")
	if lines.Code != http.StatusOK {
		t.Fatalf("lines status=%d body=%s", lines.Code, lines.Body.String())
	}
	var public []publicLine
	decodeJSON(t, lines, &public)
	if len(public) != 1 || public[0].Username != testUser.Username || !public[0].Online {
		t.Fatalf("lines=%#v", public)
	}
	assertNoStore(t, lines)
}
