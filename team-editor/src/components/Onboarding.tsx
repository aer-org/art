import { useState, useEffect, useRef } from 'react';
import './Onboarding.css';

type Step = 'plan' | 'pipeline' | 'transitions' | 'save' | null;

interface TransitionInfo {
  marker: string;
  next: string | null;
  prompt?: string;
}

interface StageInfo {
  name: string;
  description: string;
  mounts: Record<string, 'ro' | 'rw' | null>;
  transitions: TransitionInfo[];
}

const STAGE_DESCRIPTIONS_KO: Record<string, string> = {
  build: '코드를 작성하는 에이전트. PLAN.md를 읽고 src/에 구현합니다.',
  test: '작성된 코드를 테스트하는 에이전트. 엣지케이스를 찾아냅니다.',
  review: '코드와 테스트 결과를 분석하고 REPORT.md를 작성합니다.',
  history: '리포트를 읽고 INSIGHTS.md와 실험 기록을 관리합니다.',
};

const MOUNT_LABEL: Record<string, string> = {
  ro: '읽기',
  rw: '읽기/쓰기',
};

const DEFAULT_MOUNTS: Record<string, Record<string, 'ro' | 'rw' | null>> = {
  build: { plan: 'ro', src: 'rw', tests: null, metrics: 'ro' },
  test: { plan: null, src: 'ro', tests: 'rw', metrics: 'ro', outputs: 'rw' },
  review: { plan: null, src: 'ro', tests: 'ro', metrics: 'rw', outputs: 'ro' },
  history: { plan: null, src: null, tests: null, metrics: 'ro', insights: 'rw', memory: 'rw' },
};

const DEFAULT_TRANSITIONS: Record<string, TransitionInfo[]> = {
  build: [
    { marker: '[STAGE_COMPLETE]', next: 'test', prompt: '코드 구현 완료' },
    { marker: '[STAGE_ERROR]', next: null, prompt: '환경/도구/설정 에러' },
  ],
  test: [
    { marker: '[STAGE_COMPLETE]', next: null, prompt: '테스트 완료' },
    { marker: '[STAGE_ERROR]', next: 'build', prompt: '코드 수정이 필요한 에러' },
  ],
  review: [
    { marker: '[STAGE_COMPLETE]', next: null, prompt: '리뷰 리포트 작성 완료' },
    { marker: '[STAGE_ERROR]', next: null, prompt: '환경/도구/설정 에러' },
  ],
  history: [
    { marker: '[STAGE_COMPLETE]', next: null, prompt: '인사이트 정리 완료' },
    { marker: '[STAGE_ERROR]', next: null, prompt: '환경/도구/설정 에러' },
  ],
};

function MountBadges({ mounts }: { mounts: Record<string, 'ro' | 'rw' | null> }) {
  const entries = Object.entries(mounts).filter(([, v]) => v !== null) as [string, 'ro' | 'rw'][];
  if (entries.length === 0) return null;
  return (
    <div className="onboarding-mounts">
      {entries.map(([dir, perm]) => (
        <span key={dir} className={`onboarding-mount onboarding-mount--${perm}`}>
          {dir}/<span className="onboarding-mount-perm">{MOUNT_LABEL[perm]}</span>
        </span>
      ))}
    </div>
  );
}

function TransitionArrows({ transitions }: { transitions: TransitionInfo[] }) {
  return (
    <div className="onboarding-transitions">
      {transitions.map((t, i) => {
        const isError = t.marker.includes('ERROR');
        return (
          <span key={i} className={`onboarding-transition ${isError ? 'onboarding-transition--error' : 'onboarding-transition--ok'}`}>
            <span className="onboarding-transition-marker">{t.marker.replace(/[[\]]/g, '')}</span>
            <span className="onboarding-transition-arrow">→</span>
            <span className="onboarding-transition-target">
              {t.next === null
                ? (isError ? '파이프라인 중단' : '파이프라인 종료')
                : t.next}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export function Onboarding({ onPlanSaved }: { onPlanSaved?: () => void }) {
  const [step, setStep] = useState<Step>('plan');
  const [planText, setPlanText] = useState('');
  const [stages, setStages] = useState<StageInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (step === 'plan') {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [step]);

  useEffect(() => {
    if (step !== 'pipeline' && step !== 'transitions') return;
    if (stages.length > 0) return;
    fetch('/api/stage-descriptions')
      .then((r) => r.json())
      .then((data: StageInfo[]) => setStages(data))
      .catch(() => {});
  }, [step, stages.length]);

  if (step === null) return null;

  const handleNextFromPlan = async () => {
    setSaving(true);
    try {
      const content = planText.trim()
        ? `# Plan\n\n${planText.trim()}\n`
        : '# Plan\n\nDescribe what you want the agents to build.\n';
      const resp = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: content,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      onPlanSaved?.();
    } catch (err) {
      console.error('Failed to save plan:', err);
    }
    setSaving(false);
    setStep('pipeline');
  };

  const getDisplayStages = () => {
    if (stages.length > 0) {
      return stages.filter((s) => s.name in STAGE_DESCRIPTIONS_KO);
    }
    return Object.entries(STAGE_DESCRIPTIONS_KO).map(([name, description]) => ({
      name,
      description,
      mounts: DEFAULT_MOUNTS[name] ?? {},
      transitions: DEFAULT_TRANSITIONS[name] ?? [],
    }));
  };

  if (step === 'plan') {
    return (
      <div className="onboarding-overlay onboarding-overlay--plan">
        <div className="onboarding-card">
          <h1>What are you building?</h1>
          <p>Describe your project. This becomes the plan that agents will execute.</p>
          <textarea
            ref={textareaRef}
            className="onboarding-textarea"
            placeholder="e.g. A CLI tool that converts CSV files to JSON with streaming support..."
            value={planText}
            onChange={(e) => setPlanText(e.target.value)}
          />
          <button
            className="onboarding-btn"
            onClick={handleNextFromPlan}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Next →'}
          </button>
        </div>
      </div>
    );
  }

  if (step === 'pipeline') {
    const displayStages = getDisplayStages();
    return (
      <div className="onboarding-overlay onboarding-overlay--pipeline">
        <div className="onboarding-card onboarding-card--wide">
          <h1>Meet your pipeline</h1>
          <p>
            각 에이전트는 격리된 환경에서 실행되며, 지정된 디렉토리만 접근할 수 있습니다.
          </p>
          <ul className="onboarding-stages">
            {displayStages.map((s) => (
              <li key={s.name}>
                <div className="onboarding-stage-header">
                  <div className="onboarding-stage-name">{s.name}</div>
                  <div className="onboarding-stage-desc">
                    {STAGE_DESCRIPTIONS_KO[s.name] ?? s.description}
                  </div>
                </div>
                <MountBadges mounts={s.mounts} />
              </li>
            ))}
          </ul>
          <button className="onboarding-btn" onClick={() => setStep('transitions')}>
            Next →
          </button>
        </div>
      </div>
    );
  }

  if (step === 'transitions') {
    const displayStages = getDisplayStages();
    return (
      <div className="onboarding-overlay onboarding-overlay--pipeline">
        <div className="onboarding-card onboarding-card--wide">
          <h1>How stages connect</h1>
          <p>
            에이전트는 작업이 끝나면 <strong>마커</strong>를 출력합니다.
            마커에 따라 다음 스테이지로 이동하거나, 에러 시 다른 스테이지로 복귀합니다.
          </p>
          <ul className="onboarding-stages">
            {displayStages.map((s) => (
              <li key={s.name}>
                <div className="onboarding-stage-header">
                  <div className="onboarding-stage-name">{s.name}</div>
                </div>
                <TransitionArrows transitions={s.transitions} />
              </li>
            ))}
          </ul>
          <div className="onboarding-hint">
            에디터에서 노드 사이의 연결선을 드래그하면 이 전환 경로를 수정할 수 있습니다.
          </div>
          <button className="onboarding-btn" onClick={() => setStep('save')}>
            Next →
          </button>
        </div>
      </div>
    );
  }

  // step === 'save'
  return (
    <div className="onboarding-overlay onboarding-overlay--save">
      <div className="onboarding-card">
        <h1>Ready to go!</h1>
        <p>
          파이프라인이 준비되었습니다. 에디터에서 스테이지를 자유롭게 수정한 뒤,
          툴바의 <strong>Save</strong> 버튼을 눌러 저장하세요.
        </p>
        <div className="onboarding-save-hint">
          <span className="onboarding-save-icon">💾</span>
          <span>수정 후 반드시 <strong>Save</strong>를 눌러야 PIPELINE.json에 반영됩니다.</span>
        </div>
        <button className="onboarding-btn" onClick={() => setStep(null)}>
          Start editing →
        </button>
      </div>
    </div>
  );
}
