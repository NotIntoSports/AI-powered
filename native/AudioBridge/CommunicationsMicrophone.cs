using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;

namespace AudioBridge;

internal sealed record CommunicationsMicrophoneChange(bool Changed, string PreviousId, string CableId, string CableLabel);

internal static class CommunicationsMicrophone
{
    public static CommunicationsMicrophoneChange UseCableOutput()
    {
        using var devices = new MMDeviceEnumerator();
        using var previous = devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
        using var cable = devices.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active)
            .FirstOrDefault(device => device.FriendlyName.Contains("CABLE Output", StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException("CABLE_OUTPUT_NOT_FOUND");
        var changed = !StringComparer.OrdinalIgnoreCase.Equals(previous.ID, cable.ID);
        if (changed) SetDefault(cable.ID);
        using var verified = devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
        if (!StringComparer.OrdinalIgnoreCase.Equals(verified.ID, cable.ID))
            throw new InvalidOperationException("DEFAULT_COMMUNICATIONS_MIC_VERIFY_FAILED");
        return new(changed, previous.ID, cable.ID, cable.FriendlyName);
    }

    public static void Restore(string endpointId)
    {
        if (string.IsNullOrWhiteSpace(endpointId)) return;
        SetDefault(endpointId);
        using var devices = new MMDeviceEnumerator();
        using var verified = devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
        if (!StringComparer.OrdinalIgnoreCase.Equals(verified.ID, endpointId))
            throw new InvalidOperationException("DEFAULT_COMMUNICATIONS_MIC_RESTORE_FAILED");
    }

    private static void SetDefault(string endpointId)
    {
        var policy = (IPolicyConfig)new PolicyConfigClient();
        try
        {
            Marshal.ThrowExceptionForHR(policy.SetDefaultEndpoint(endpointId, Role.Communications));
        }
        finally
        {
            Marshal.FinalReleaseComObject(policy);
        }
    }
}

[ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
internal class PolicyConfigClient { }

[ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPolicyConfig
{
    [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr format);
    [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int isDefault, IntPtr format);
    [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId);
    [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr endpointFormat, IntPtr mixFormat);
    [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int isDefault, IntPtr defaultPeriod, IntPtr minimumPeriod);
    [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr period);
    [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr mode);
    [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr mode);
    [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr key, IntPtr value);
    [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr key, IntPtr value);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, Role role);
    [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int visible);
}
