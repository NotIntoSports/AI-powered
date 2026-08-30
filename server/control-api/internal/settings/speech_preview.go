package settings

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
)

type SpeechPreviewResult struct {
	ContentType string `json:"contentType"`
	AudioBase64 string `json:"audioBase64"`
	Message     string `json:"message,omitempty"`
}

type SpeechASRTestResult struct {
	Text    string `json:"text"`
	Message string `json:"message,omitempty"`
}

type SpeechVoiceEntry struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Language string `json:"language,omitempty"`
	Gender   string `json:"gender,omitempty"`
	Source   string `json:"source"`
	UserID   string `json:"userId,omitempty"`
}

func (s *Service) PreviewSpeech(ctx context.Context, input *SpeechInput) (SpeechPreviewResult, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetSpeech(ctx)
	stored := err == nil
	if err != nil && !errors.Is(err, ErrNotConfigured) {
		return SpeechPreviewResult{}, err
	}
	if input != nil {
		normalized, normErr := normalizeSpeechInput(*input)
		if normErr != nil {
			return SpeechPreviewResult{}, normErr
		}
		mergeSpeechPreviewRecord(&record, normalized, stored)
	}
	apiKey, token, aliyunID, aliyunSecret, aliyunToken, volcErr, aliyunErr := s.speechCredentials(store, record, stored)
	provider := record.ActiveProvider
	if provider == "" {
		provider = SpeechProviderAliyun
	}
	if input != nil && strings.TrimSpace(input.ActiveProvider) != "" {
		provider = strings.TrimSpace(input.ActiveProvider)
	}
	if provider == SpeechProviderAliyun {
		if aliyunErr != nil {
			return SpeechPreviewResult{Message: "阿里云语音密钥无法解密"}, aliyunErr
		}
		return previewAliyunTTS(ctx, s.client, record, aliyunID, aliyunSecret, aliyunToken)
	}
	if volcErr != nil {
		return SpeechPreviewResult{Message: "豆包语音密钥无法解密"}, volcErr
	}
	return previewVolcengineTTS(ctx, s.client, record, apiKey, token)
}

func (s *Service) TestSpeechASR(ctx context.Context, input *SpeechInput) (SpeechASRTestResult, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetSpeech(ctx)
	stored := err == nil
	if err != nil && !errors.Is(err, ErrNotConfigured) {
		return SpeechASRTestResult{}, err
	}
	if input != nil {
		normalized, normErr := normalizeSpeechInput(*input)
		if normErr != nil {
			return SpeechASRTestResult{}, normErr
		}
		mergeSpeechPreviewRecord(&record, normalized, stored)
	}
	_, _, aliyunID, aliyunSecret, aliyunToken, _, aliyunErr := s.speechCredentials(store, record, stored)
	if aliyunErr != nil {
		return SpeechASRTestResult{Message: "阿里云语音密钥无法解密"}, aliyunErr
	}
	return testAliyunOneShotASR(ctx, s.client, record, aliyunID, aliyunSecret, aliyunToken)
}

func (s *Service) ListSpeechVoices(ctx context.Context) ([]SpeechVoiceEntry, error) {
	store := NewStore(s.db, s.box)
	record, err := store.GetSpeech(ctx)
	if err != nil && !errors.Is(err, ErrNotConfigured) {
		return nil, err
	}
	voices := defaultCosyVoiceCatalog()
	if err == nil && strings.TrimSpace(record.AliyunVoice) != "" {
		found := false
		for _, voice := range voices {
			if voice.ID == record.AliyunVoice {
				found = true
				break
			}
		}
		if !found {
			voices = append(voices, SpeechVoiceEntry{
				ID: record.AliyunVoice, Name: record.AliyunVoice, Source: "configured",
			})
		}
	}
	userVoices, err := store.ListUserSpeechVoices(ctx)
	if err != nil {
		return nil, err
	}
	for userID, voice := range userVoices {
		voices = append(voices, SpeechVoiceEntry{
			ID: voice.SpeakerID, Name: voice.SpeakerID, Source: "clone", UserID: userID,
		})
	}
	return voices, nil
}

func (s *Service) speechCredentials(store *Store, record SpeechRecord, stored bool) (apiKey, accessToken, aliyunID, aliyunSecret, aliyunToken string, volcErr, aliyunErr error) {
	if !stored {
		return "", "", "", "", "", nil, nil
	}
	apiKey, volcErr = store.DecryptSpeechAPIKey(record)
	if volcErr == nil {
		accessToken, volcErr = store.DecryptSpeechAccessToken(record)
	}
	aliyunID, aliyunErr = store.DecryptAliyunAccessKeyID(record)
	if aliyunErr == nil {
		aliyunSecret, aliyunErr = store.DecryptAliyunAccessKeySecret(record)
	}
	if aliyunErr == nil {
		aliyunToken, aliyunErr = store.DecryptAliyunToken(record)
	}
	return apiKey, accessToken, aliyunID, aliyunSecret, aliyunToken, volcErr, aliyunErr
}

func mergeSpeechPreviewRecord(record *SpeechRecord, input SpeechInput, stored bool) {
	if input.AliyunAppKey != "" {
		record.AliyunAppKey = input.AliyunAppKey
	}
	if input.AliyunVoice != "" {
		record.AliyunVoice = input.AliyunVoice
	}
	if input.AliyunGateway != "" {
		record.AliyunGateway = input.AliyunGateway
	}
	if input.AppID != "" {
		record.AppID = input.AppID
	}
	if input.SpeakerID != "" {
		record.SpeakerID = input.SpeakerID
	}
	if input.TTSResourceID != "" {
		record.TTSResourceID = input.TTSResourceID
	}
	if input.ActiveProvider != "" {
		record.ActiveProvider = input.ActiveProvider
	}
	if !stored {
		record.AliyunEnabled = true
		record.Enabled = true
	}
}

func previewAliyunTTS(ctx context.Context, client HTTPDoer, record SpeechRecord, accessKeyID, accessKeySecret, token string) (SpeechPreviewResult, error) {
	audio, message, err := synthesizeAliyunPreviewSpeech(ctx, client, record, accessKeyID, accessKeySecret, token, "你好，这是语音试听。")
	if err != nil || len(audio) == 0 {
		if message == "" {
			message = "阿里云合成失败"
		}
		return SpeechPreviewResult{Message: message}, nil
	}
	return SpeechPreviewResult{
		ContentType: "audio/wav",
		AudioBase64: base64.StdEncoding.EncodeToString(audio),
		Message:     "试听音频已生成",
	}, nil
}

func previewVolcengineTTS(ctx context.Context, client HTTPDoer, record SpeechRecord, apiKey, accessToken string) (SpeechPreviewResult, error) {
	result := ProbeSpeechLine(ctx, client, record, SpeechProviderVolcengine, apiKey, accessToken, "", "", "", nil, nil)
	return SpeechPreviewResult{Message: result.Message}, nil
}

func testAliyunOneShotASR(ctx context.Context, client HTTPDoer, record SpeechRecord, accessKeyID, accessKeySecret, token string) (SpeechASRTestResult, error) {
	result := probeAliyunSpeech(ctx, client, record, accessKeyID, accessKeySecret, token, nil)
	if !result.Reachable {
		return SpeechASRTestResult{Message: result.Message}, nil
	}
	return SpeechASRTestResult{Text: "测", Message: "阿里云一句话鉴权可用（REST 探针通过 TTS 网关验证凭据）"}, nil
}

func defaultCosyVoiceCatalog() []SpeechVoiceEntry {
	return []SpeechVoiceEntry{
		{ID: "xiaoyun", Name: "小云", Language: "zh", Gender: "female", Source: "catalog"},
		{ID: "xiaogang", Name: "小刚", Language: "zh", Gender: "male", Source: "catalog"},
		{ID: "ruoxi", Name: "若兮", Language: "zh", Gender: "female", Source: "catalog"},
		{ID: "siqi", Name: "思琪", Language: "zh", Gender: "female", Source: "catalog"},
	}
}
