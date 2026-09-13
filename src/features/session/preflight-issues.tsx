import { Link } from "wouter";
import type { PreflightIssue } from "../../generated/bindings";

export function describeIssue(issue: PreflightIssue) {
  switch (issue.code) {
    case "SESSION_ROLE_REQUIRED": return { text: "请选择一个会话角色。", href: "/settings?category=roles", action: "选择或创建角色" };
    case "SESSION_ROUTE_REQUIRED": return { text: "请先配置并启用语音线路。", href: "/services?category=routes", action: "配置语音线路" };
    case "SESSION_STAGE_INCOMPLETE": return { text: "语音线路的模型配置不完整。", href: "/services?category=routes", action: "补全语音线路" };
    case "SESSION_CREDENTIAL_MISSING": return { text: "模型服务缺少有效的 API Key。", href: "/services?category=providers", action: "配置模型服务" };
    case "SESSION_DATABASE_UNAVAILABLE": return { text: "本地资料库暂时不可用，请修复配置或重启应用。", href: "/settings", action: "打开设置" };
    default: return { text: "会话启动遇到问题，请检查相关配置后重试。", href: "/settings", action: "打开设置" };
  }
}

export function PreflightIssues({ issues }: { issues: PreflightIssue[] }) {
  if (!issues.length) return null;
  return <div className="services-message" role="status" aria-label="会话启动检查">
    {issues.map((issue, index) => {
      const help = describeIssue(issue);
      return <div key={`${issue.code}-${index}`}><span>{help.text} </span><Link href={help.href}>{help.action}</Link></div>;
    })}
  </div>;
}
