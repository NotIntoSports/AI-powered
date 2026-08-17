package httpapi

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/presence"
	"github.com/ai-interviewer/ai-powered/control-api/internal/settings"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
)

type PresenceAdmin interface {
	ListUserPresence(ctx context.Context) (map[string]presence.UserPresence, error)
	ListLines(ctx context.Context) ([]presence.Line, error)
	ListDevices(ctx context.Context) ([]presence.Device, error)
}

type adminUser struct {
	publicUser
	Online             bool       `json:"online"`
	LastSeenAt         *time.Time `json:"lastSeenAt,omitempty"`
	ActiveSessionCount int        `json:"activeSessionCount"`
	VoiceBound          bool       `json:"voiceBound"`
	SpeakerID          string     `json:"speakerId,omitempty"`
	VoiceBoundAt        *time.Time `json:"voiceBoundAt,omitempty"`
}

type publicLine struct {
	ID         string     `json:"id"`
	UserID     string     `json:"userId"`
	Username   string     `json:"username"`
	Purpose    string     `json:"purpose"`
	DeviceID   string     `json:"deviceId,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	Online     bool       `json:"online"`
}

type publicDevice struct {
	ID            string    `json:"id"`
	UserID        string    `json:"userId"`
	Username      string    `json:"username"`
	ClientVersion string    `json:"clientVersion"`
	OS            string    `json:"os"`
	OSVersion     string    `json:"osVersion"`
	LastSeenAt    time.Time `json:"lastSeenAt"`
	Disabled      bool      `json:"disabled"`
	Online        bool      `json:"online"`
}

type adminPresenceHandler struct {
	admin PresenceAdmin
}

func newAdminPresenceHandler(admin PresenceAdmin) *adminPresenceHandler {
	return &adminPresenceHandler{admin: admin}
}

func (handler *adminPresenceHandler) listLines(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	lines, err := handler.admin.ListLines(request.Context())
	if err != nil {
		writeAPIError(w, request, http.StatusInternalServerError, "INTERNAL_ERROR", "presence service unavailable")
		return
	}
	public := make([]publicLine, 0, len(lines))
	for _, line := range lines {
		public = append(public, publicLine{
			ID:         line.ID,
			UserID:     line.UserID,
			Username:   line.Username,
			Purpose:    line.Purpose,
			DeviceID:   line.DeviceID,
			CreatedAt:  line.CreatedAt,
			ExpiresAt:  line.ExpiresAt,
			LastUsedAt: line.LastUsedAt,
			Online:     line.Online,
		})
	}
	writeJSON(w, http.StatusOK, public)
}

func (handler *adminPresenceHandler) listDevices(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	devices, err := handler.admin.ListDevices(request.Context())
	if err != nil {
		writeAPIError(w, request, http.StatusInternalServerError, "INTERNAL_ERROR", "presence service unavailable")
		return
	}
	public := make([]publicDevice, 0, len(devices))
	for _, device := range devices {
		public = append(public, publicDevice{
			ID:            device.ID,
			UserID:        device.UserID,
			Username:      device.Username,
			ClientVersion: device.ClientVersion,
			OS:            device.OS,
			OSVersion:     device.OSVersion,
			LastSeenAt:    device.LastSeenAt,
			Disabled:      device.Disabled,
			Online:        device.Online,
		})
	}
	writeJSON(w, http.StatusOK, public)
}

func mergeAdminUsers(
	listed []users.User,
	presenceByUser map[string]presence.UserPresence,
	voicesByUser map[string]settings.UserSpeechVoice,
) []adminUser {
	out := make([]adminUser, 0, len(listed))
	for _, user := range listed {
		item := adminUser{publicUser: toPublicUser(user)}
		if snapshot, ok := presenceByUser[user.ID]; ok {
			item.Online = snapshot.Online
			item.LastSeenAt = snapshot.LastSeenAt
			item.ActiveSessionCount = snapshot.ActiveSessionCount
		}
		if voice, ok := voicesByUser[user.ID]; ok && strings.TrimSpace(voice.SpeakerID) != "" {
			item.VoiceBound = true
			item.SpeakerID = strings.TrimSpace(voice.SpeakerID)
			boundAt := voice.UpdatedAt.UTC()
			item.VoiceBoundAt = &boundAt
		}
		out = append(out, item)
	}
	return out
}
