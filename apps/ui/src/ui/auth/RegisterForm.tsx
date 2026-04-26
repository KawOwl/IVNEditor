/**
 * RegisterForm — 邮箱 + 密码 + 6 题用户画像 → POST /api/auth/register（PFB.2）
 *
 * 单一流程：填表 + 提交 + 回调 onSuccess。不带"取消"按钮，由父组件
 * 决定要不要包 close 入口（典型用法是 RegistrationGate，强制流程不允许关）。
 *
 * 选项原文必须与后端 routes/auth.mts 里的 enum 同步发布；后端 zod 严格校验。
 */

import { useCallback, useState } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { fetchWithAuth } from '@/stores/player-session-store';
import { getBackendUrl } from '@/lib/backend-url';
import { cn } from '@/lib/utils';

const PROFILE_RADIO_QUESTIONS = [
  {
    key: 'gender' as const,
    title: '您的性别是',
    options: ['男生', '女生'],
  },
  {
    key: 'grade' as const,
    title: '您目前的年级是',
    options: ['大一/大二', '大三/大四', '研究生及以上'],
  },
  {
    key: 'major' as const,
    title: '您所学的专业大类属于',
    options: [
      '文史哲 / 外语 / 传媒类',
      '计算机 / 理工科类',
      '艺术 / 设计 / 影视类',
      '经管 / 法学 / 其他类',
    ],
  },
  {
    key: 'monthlyBudget' as const,
    title: '您每月可自由支配的娱乐消费大概在哪个区间？',
    options: ['100元以内', '100元 - 300元', '300元 - 500元', '500元以上'],
  },
] as const;

type ProfileRadioKey = typeof PROFILE_RADIO_QUESTIONS[number]['key'];

const HOBBY_OPTIONS = [
  '阅读长篇文字',
  '参与线下社交推演',
  '混迹二次元/泛娱乐社区',
  '刷短视频/追剧',
  '玩游戏大作',
] as const;

const PASSWORD_MIN_LEN = 8;
const AFFILIATION_MAX_LEN = 200;
const HOBBY_MAX_PICK = 2;

export function RegisterForm({ onSuccess }: { onSuccess?: () => void }) {
  const checkMe = useAuthStore((s) => s.checkMe);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [affiliation, setAffiliation] = useState('');
  const [profileRadios, setProfileRadios] = useState<Partial<Record<ProfileRadioKey, string>>>({});
  const [hobbies, setHobbies] = useState<string[]>([]);
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const passwordValid = password.length >= PASSWORD_MIN_LEN;
  const affiliationValid =
    affiliation.trim().length > 0 && affiliation.trim().length <= AFFILIATION_MAX_LEN;
  const radiosValid = PROFILE_RADIO_QUESTIONS.every((q) => profileRadios[q.key]);
  const hobbiesValid = hobbies.length >= 1 && hobbies.length <= HOBBY_MAX_PICK;

  const canSubmit =
    submitState !== 'submitting' &&
    emailValid &&
    passwordValid &&
    affiliationValid &&
    radiosValid &&
    hobbiesValid;

  const toggleHobby = useCallback((opt: string) => {
    setHobbies((prev) => {
      if (prev.includes(opt)) return prev.filter((h) => h !== opt);
      if (prev.length >= HOBBY_MAX_PICK) return prev;
      return [...prev, opt];
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitState('submitting');
    setErrorMsg(null);
    try {
      const res = await fetchWithAuth(`${getBackendUrl()}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
          profile: {
            affiliation: affiliation.trim(),
            gender: profileRadios.gender,
            grade: profileRadios.grade,
            major: profileRadios.major,
            monthlyBudget: profileRadios.monthlyBudget,
            hobbies,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: '注册失败' }));
        if (res.status === 409) {
          throw new Error(body.error ?? '邮箱已被注册');
        }
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // 注册成功 → 刷新 auth-store 的 identity → kind 从 anonymous → registered
      await checkMe();
      onSuccess?.();
    } catch (err) {
      setSubmitState('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [
    affiliation,
    canSubmit,
    checkMe,
    email,
    hobbies,
    onSuccess,
    password,
    profileRadios,
  ]);

  return (
    <>
      <div className="flex-none px-5 py-4 border-b border-zinc-800">
        <h2 className="text-sm font-medium text-zinc-200">先做一下简单注册</h2>
        <p className="text-[11px] text-zinc-500 mt-1">
          邮箱+密码用于以后再来访问；下面 6 题用户画像帮我们分析样本。
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* 邮箱 */}
        <fieldset className="space-y-1">
          <legend className="text-xs text-zinc-300">
            <span className="text-red-400 mr-1">*</span>邮箱
          </legend>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={submitState === 'submitting'}
            className="w-full px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs focus:outline-none focus:border-emerald-600"
            autoFocus
          />
          {email.length > 0 && !emailValid && (
            <p className="text-[11px] text-amber-500">邮箱格式不正确</p>
          )}
        </fieldset>

        {/* 密码 */}
        <fieldset className="space-y-1">
          <legend className="text-xs text-zinc-300">
            <span className="text-red-400 mr-1">*</span>密码（至少 {PASSWORD_MIN_LEN} 位）
          </legend>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitState === 'submitting'}
            className="w-full px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs focus:outline-none focus:border-emerald-600"
          />
          {password.length > 0 && !passwordValid && (
            <p className="text-[11px] text-amber-500">至少 {PASSWORD_MIN_LEN} 位</p>
          )}
        </fieldset>

        <div className="border-t border-zinc-800 pt-4">
          <p className="text-[11px] text-zinc-500 mb-3">— 用户画像（6 题）—</p>
        </div>

        {/* Q1 单位/学号 */}
        <fieldset className="space-y-1">
          <legend className="text-xs text-zinc-300">
            <span className="text-zinc-500 mr-1">1.</span>
            <span className="text-red-400 mr-1">*</span>您的单位/学号是
          </legend>
          <input
            type="text"
            value={affiliation}
            onChange={(e) => setAffiliation(e.target.value)}
            maxLength={AFFILIATION_MAX_LEN}
            disabled={submitState === 'submitting'}
            className="w-full px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs focus:outline-none focus:border-emerald-600"
          />
        </fieldset>

        {/* Q2-Q5 单选 */}
        {PROFILE_RADIO_QUESTIONS.map((q, idx) => (
          <fieldset key={q.key} className="space-y-2">
            <legend className="text-xs text-zinc-300 leading-relaxed">
              <span className="text-zinc-500 mr-1">{idx + 2}.</span>
              <span className="text-red-400 mr-1">*</span>
              {q.title}
            </legend>
            <div className="space-y-1.5 pl-4">
              {q.options.map((opt) => {
                const checked = profileRadios[q.key] === opt;
                return (
                  <label
                    key={opt}
                    className={cn(
                      'flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer text-xs leading-relaxed',
                      checked
                        ? 'bg-emerald-900/30 text-zinc-100'
                        : 'text-zinc-400 hover:bg-zinc-800/60',
                    )}
                  >
                    <input
                      type="radio"
                      name={q.key}
                      value={opt}
                      checked={checked}
                      onChange={() => setProfileRadios((p) => ({ ...p, [q.key]: opt }))}
                      disabled={submitState === 'submitting'}
                      className="mt-0.5 accent-emerald-600"
                    />
                    <span>{opt}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}

        {/* Q6 hobbies 多选 1-2 */}
        <fieldset className="space-y-2">
          <legend className="text-xs text-zinc-300 leading-relaxed">
            <span className="text-zinc-500 mr-1">6.</span>
            <span className="text-red-400 mr-1">*</span>
            课余时间您的爱好是（选 1-2 个，{hobbies.length}/{HOBBY_MAX_PICK}）
          </legend>
          <div className="space-y-1.5 pl-4">
            {HOBBY_OPTIONS.map((opt) => {
              const checked = hobbies.includes(opt);
              const wouldExceed = !checked && hobbies.length >= HOBBY_MAX_PICK;
              return (
                <label
                  key={opt}
                  className={cn(
                    'flex items-start gap-2 px-2 py-1.5 rounded text-xs leading-relaxed',
                    checked
                      ? 'bg-emerald-900/30 text-zinc-100 cursor-pointer'
                      : wouldExceed
                        ? 'text-zinc-600 cursor-not-allowed'
                        : 'text-zinc-400 hover:bg-zinc-800/60 cursor-pointer',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={submitState === 'submitting' || wouldExceed}
                    onChange={() => toggleHobby(opt)}
                    className="mt-0.5 accent-emerald-600"
                  />
                  <span>{opt}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </div>

      <div className="flex-none px-5 py-3 border-t border-zinc-800 flex items-center gap-2">
        <span
          className={cn(
            'text-[11px] flex-1',
            submitState === 'error' ? 'text-red-400' : 'text-zinc-500',
          )}
        >
          {submitState === 'error' && (errorMsg ?? '注册失败，请重试')}
          {submitState === 'submitting' && '注册中…'}
        </span>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="text-xs px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          注册
        </button>
      </div>
    </>
  );
}
