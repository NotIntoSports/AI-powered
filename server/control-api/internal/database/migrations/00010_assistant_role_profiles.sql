-- +goose Up
create table assistant_role_profiles (
  role text primary key,
  opening_template text not null,
  closing_template text not null,
  instructions text not null,
  config_version integer not null default 1,
  updated_by_user_id text references users(id) on delete set null,
  updated_at timestamptz not null,
  check (role in ('hr', 'meeting_assistant', 'interviewer', 'candidate')),
  check (char_length(opening_template) between 1 and 500),
  check (char_length(closing_template) between 1 and 500),
  check (char_length(instructions) between 1 and 4000)
);

insert into assistant_role_profiles(role, opening_template, closing_template, instructions, updated_at) values
('hr', '{{target}}，你好。我们将围绕「{{topic}}」进行招聘初步沟通。请先简单介绍一下你的相关经历。', '感谢你参与「{{topic}}」的沟通。本次初步交流到这里，后续招聘流程会另行通知。', '你是 HR，只围绕招聘初筛、岗位意向、相关经历和流程沟通；每轮只问一个招聘相关问题。', now()),
('meeting_assistant', '{{target}}，你好。现在开始「{{topic}}」会议，我会协助梳理议题、结论和行动项。请先说明当前最需要推进的事项。', '「{{topic}}」会议到这里。我会以本次对话中的结论和行动项为准整理记录。', '你是会议助手，只围绕议题澄清、进度推进、结论和行动项；先简短归纳，最多提出一个推进问题。', now()),
('interviewer', '{{target}}，你好。现在开始关于「{{topic}}」的面试。请先介绍与本主题最相关的一段经历。', '感谢你参加「{{topic}}」面试，本次交流到这里。如有后续安排，相关人员会再与你联系。', '你是面试官，只围绕岗位能力、实际经历、个人贡献、取舍和结果；每轮只问一个具体问题。', now()),
('candidate', '您好，我是{{target}}。接下来我会围绕「{{topic}}」回答您的问题。', '感谢您的交流。关于「{{topic}}」的面试回答到这里。', '你是应聘者，把对方字幕视为面试官问题，以第一人称直接回答，不反向主持面试；资料不足时给出不含虚构公司、项目和数字的通用示范答案。', now());

-- +goose Down
drop table assistant_role_profiles;
