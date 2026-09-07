import { TelegramMessage } from '../types';

export const SAMPLE_TELEGRAM_MESSAGES: TelegramMessage[] = [
  {
    id: 'msg-1',
    sender: 'HackerNews Daily Digest',
    senderHandle: '@hn_daily_radar',
    channelName: 'HN Top Radar',
    timestamp: 'Today at 10:14 AM',
    text: `🚨 Trending on HN (1,420 points, 680 comments):
"Show HN: A single developer rewrote the entire React engine in 900 lines of Rust with zero dependencies"
Creator claims 40x faster DOM reconciliations and 12KB bundle size. The comment section is in absolute flames: half the users are praising the genius architectural simplicity, while core maintainers are pointing out 14 edge cases with hydration and concurrent mode. Is this the end of traditional JS frameworks or just another weekend benchmark flex?

Discussion link: news.ycombinator.com/item?id=39841205`,
    topicDetected: 'Solo Dev Rewrites React in 900 Lines of Rust',
    tags: ['Rust', 'React', 'WebDev', 'Benchmark Drama', 'ShowHN'],
    views: '14.2k',
    sourceUrl: 'https://news.ycombinator.com/item?id=39841205'
  },
  {
    id: 'msg-2',
    sender: 'Silicon Leaks & Tech',
    senderHandle: '@silicon_leaks',
    channelName: 'Hacker News Frontpage',
    timestamp: 'Today at 08:30 AM',
    text: `⚡ Hacker News Top 1:
"The SSH Backdoor That Almost Broke the Entire Linux Internet: Inside the XZ Utils Heist"
A multi-year social engineering campaign where an anonymous persona named Jia Tan patiently contributed code for 3 years before sneaking an ultra-stealth binary backdoor into liblzma. Discovered purely by accident by a Microsoft engineer who noticed a 500ms SSH latency spike. The tech world is reconsidering all volunteer-maintained open-source foundations.

Thread: news.ycombinator.com/item?id=39865810`,
    topicDetected: 'The XZ Utils SSH Backdoor & 3-Year Social Engineering Heist',
    tags: ['Cybersecurity', 'Linux', 'Open Source', 'Social Engineering', 'ZeroDay'],
    views: '28.9k',
    sourceUrl: 'https://news.ycombinator.com/item?id=39865810'
  },
  {
    id: 'msg-3',
    sender: 'AI Frontier News',
    senderHandle: '@ai_frontier',
    channelName: 'HN AI Dispatch',
    timestamp: 'Yesterday at 4:45 PM',
    text: `🤖 Top Hacker News Story:
"Why AI Agents Keep Getting Stuck in Infinite Loops (And how a 21-year-old fixed it with Game Theory)"
Post dissects why autonomous coding agents hallucinate into infinite recursive loops when running unit tests. The author introduced a minimax game-theory referee that treats the agent as a competitive adversary. 950 upvotes and heated debates on whether agents need reinforcement or strict grammar state machines.

Link: news.ycombinator.com/item?id=39772199`,
    topicDetected: 'Game Theory Fix for Autonomous AI Agent Infinite Loops',
    tags: ['AI Agents', 'GameTheory', 'LLM', 'AutonomousCode', 'HN Debate'],
    views: '19.5k',
    sourceUrl: 'https://news.ycombinator.com/item?id=39772199'
  },
  {
    id: 'msg-4',
    sender: 'DevOps & Sysadmin Underground',
    senderHandle: '@devops_underground',
    channelName: 'HN Incident Reports',
    timestamp: 'Yesterday at 11:20 AM',
    text: `💥 "Postmortem: How a single bad regex took down half the cloud for 4 hours"
A cloud provider engineer updated an email validation regex with an unescaped wildcard, triggering catastrophic catastrophic backtracking on 100k servers simultaneously. CPU loads spiked to 1000%. HN comments are filled with senior engineers recounting their own worst production wipeouts.

HN Link: news.ycombinator.com/item?id=39655012`,
    topicDetected: 'Catastrophic ReDoS Regex Cloud Outage Postmortem',
    tags: ['DevOps', 'Postmortem', 'Outage', 'Regex', 'Cloud'],
    views: '11.8k',
    sourceUrl: 'https://news.ycombinator.com/item?id=39655012'
  }
];
