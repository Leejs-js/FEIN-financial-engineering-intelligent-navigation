import { Info, RotateCcw } from 'lucide-react';
import { resetMockApi } from './mockApi';

/** 포트폴리오 데모 안내 — 목업 API가 켜져 있을 때만 화면 최상단에 붙는다. */
export default function DemoBanner() {
  const handleReset = () => {
    resetMockApi();
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* 저장소 접근 실패 시에도 새로고침은 진행 */
    }
    window.location.reload();
  };

  return (
    <div className="bg-navy text-white text-xs sm:text-sm">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2">
        <Info size={16} className="shrink-0 text-lime" aria-hidden />
        <p className="min-w-0 flex-1 leading-snug">
          <span className="font-semibold text-lime">포트폴리오 데모</span>
          <span className="mx-1.5 opacity-40">·</span>
          아무 아이디/비밀번호로 로그인할 수 있어요
          <span className="mx-1.5 opacity-40">·</span>
          모든 데이터는 가상이에요
        </p>
        <button
          type="button"
          onClick={handleReset}
          className="flex shrink-0 items-center gap-1 rounded-full bg-lime px-3 py-1 font-semibold text-accent-ink transition hover:opacity-90"
        >
          <RotateCcw size={13} aria-hidden />
          <span className="hidden sm:inline">데이터 </span>초기화
        </button>
      </div>
    </div>
  );
}
