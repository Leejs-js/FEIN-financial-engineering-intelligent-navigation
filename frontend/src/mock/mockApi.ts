/**
 * 포트폴리오 캡처용 목업 API.
 *
 * 백엔드 리소스가 삭제돼 실제 API가 동작하지 않으므로, 브라우저의 fetch를 가로채
 * `/api/v1/*` 요청에 목업 응답을 돌려준다. backendApi.ts / backtestApi.ts / informationApi.ts는
 * 수정하지 않고 그대로 쓴다. VITE_MOCK_API=false 로 끄면 실제 API를 호출한다.
 */
import { ALL_HOLDINGS, STOCK_INFO } from '../data/holdings';
import { RISK_QUESTIONS } from '../data/riskQuestions';

type Json = unknown;

const LATENCY_MS = 180;
const API_PREFIX = '/api/v1';

/* ------------------------------------------------------------------ */
/* 유틸                                                                 */
/* ------------------------------------------------------------------ */

function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const dec = (v: number, digits = 2) => v.toFixed(digits);
const today = () => new Date();
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

function addDays(d: Date, days: number) {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

/** 주말을 건너뛴 영업일 목록(오래된 순) */
function businessDays(count: number, end = today()) {
  const days: Date[] = [];
  let cursor = new Date(end);
  while (days.length < count) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) days.unshift(new Date(cursor));
    cursor = addDays(cursor, -1);
  }
  return days;
}

/* ------------------------------------------------------------------ */
/* 종목 카탈로그                                                         */
/* ------------------------------------------------------------------ */

interface MockStock {
  code: string;
  name: string;
  sector: string;
  price: number;
  previousClose: number;
  changeRate: number;
  weight: number; // 현재 비중 %
  target: number; // 목표 비중 %
  returnRate: number; // 평가 수익률 %
  why: string;
}

const STOCKS: MockStock[] = ALL_HOLDINGS.map((h) => {
  const info = STOCK_INFO[h.name];
  const chg = h.chg ?? 0;
  const previousClose = Math.round(info.price / (1 + chg / 100));
  return {
    code: info.code,
    name: h.name,
    sector: h.sector,
    price: info.price,
    previousClose,
    changeRate: chg,
    weight: h.pct,
    target: h.target ?? h.pct,
    returnRate: h.returnRate ?? 0,
    why: h.why,
  };
});

const stockByCode = (code: string) => STOCKS.find((s) => s.code === code);

function parseNumber(text: string) {
  const n = parseFloat(text.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/* 상태 (메모리 + localStorage)                                          */
/* ------------------------------------------------------------------ */

type Mode = 'AUTO' | 'SEMI_AUTO';

interface MockAccount {
  id: string;
  account_name: string;
  operation_mode: Mode;
  initial_cash: number;
  cash_balance: number;
  invested_principal: number;
  status: string;
  selected_strategy_id: string | null;
  created_at: string;
  /** 계좌 성과 배율 — 자동/반자동 비교 화면에서 두 계좌 수익률이 다르게 보이도록 */
  performance: number;
}

interface MockState {
  user: { id: number; user_id: string; name: string; email: string; account_status: string };
  accounts: Record<Mode, MockAccount>;
  carGoal: { car_grade: 'INEX' | 'HIGHEND'; goal_amount: number; updated_at: string } | null;
  decisions: Array<Record<string, Json>>;
  extraOrders: Array<Record<string, Json>>;
}

const STATE_KEY = 'fein.mock-api-state.v1';

function initialState(): MockState {
  const created = addDays(today(), -182).toISOString();
  return {
    user: {
      id: 1,
      user_id: 'fein_demo',
      name: '김핀',
      email: 'demo@fein.ai',
      account_status: 'ACTIVE',
    },
    accounts: {
      SEMI_AUTO: {
        id: 'acc-semi-0001',
        account_name: '나의 가상 투자계좌',
        operation_mode: 'SEMI_AUTO',
        initial_cash: 10_000_000,
        cash_balance: 412_380,
        invested_principal: 10_000_000,
        status: 'ACTIVE',
        selected_strategy_id: 'low',
        created_at: created,
        performance: 1,
      },
      AUTO: {
        id: 'acc-auto-0001',
        account_name: 'AI 자동투자 계좌',
        operation_mode: 'AUTO',
        initial_cash: 10_000_000,
        cash_balance: 286_140,
        invested_principal: 10_000_000,
        status: 'ACTIVE',
        selected_strategy_id: 'momentum',
        created_at: created,
        performance: 1.32,
      },
    },
    carGoal: { car_grade: 'INEX', goal_amount: 30_000_000, updated_at: nowIso() },
    decisions: [],
    extraOrders: [],
  };
}

function loadState(): MockState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return JSON.parse(raw) as MockState;
  } catch {
    /* 저장소 접근 실패 시 초기값 사용 */
  }
  return initialState();
}

let state = loadState();

function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    /* 무시 */
  }
}

export function resetMockApi() {
  state = initialState();
  saveState();
}

/** 콘솔에서 `__resetMockApi()` 로 목업 상태를 초기화할 수 있다. */
(globalThis as Record<string, unknown>).__resetMockApi = resetMockApi;

const accountById = (id: string | null) =>
  Object.values(state.accounts).find((a) => a.id === id) ?? state.accounts.SEMI_AUTO;

/* ------------------------------------------------------------------ */
/* 응답 빌더                                                             */
/* ------------------------------------------------------------------ */

function accountResponse(a: MockAccount) {
  return {
    id: a.id,
    account_name: a.account_name,
    operation_mode: a.operation_mode,
    initial_cash: dec(a.initial_cash),
    cash_balance: dec(a.cash_balance),
    invested_principal: dec(a.invested_principal),
    status: a.status,
    selected_strategy_id: a.selected_strategy_id,
    created_at: a.created_at,
  };
}

function buildPositions(a: MockAccount) {
  const investable = a.invested_principal - a.cash_balance;
  const totalWeight = STOCKS.reduce((sum, s) => sum + s.weight, 0);
  const rows = STOCKS.map((s) => {
    const rate = s.returnRate * a.performance;
    const purchase = (investable * s.weight) / totalWeight;
    const evaluation = purchase * (1 + rate / 100);
    const quantity = Math.max(1, Math.round(evaluation / s.price));
    const evalAmount = quantity * s.price;
    const avgPrice = evalAmount / (1 + rate / 100) / quantity;
    const purchaseAmount = avgPrice * quantity;
    return { s, quantity, avgPrice, purchaseAmount, evalAmount };
  });
  const totalEval = rows.reduce((sum, r) => sum + r.evalAmount, 0);
  return rows.map(({ s, quantity, avgPrice, purchaseAmount, evalAmount }) => {
    const unrealized = evalAmount - purchaseAmount;
    return {
      stock_code: s.code,
      stock_name: s.name,
      sector: s.sector,
      quantity: dec(quantity, 0),
      average_price: dec(avgPrice),
      current_price: dec(s.price),
      previous_close: dec(s.previousClose),
      change_rate: dec(s.changeRate),
      purchase_amount: dec(purchaseAmount),
      evaluation_amount: dec(evalAmount),
      unrealized_profit: dec(unrealized),
      return_rate: dec((unrealized / purchaseAmount) * 100),
      realized_profit: dec(0),
      weight: dec((evalAmount / totalEval) * 100),
      today_profit: dec(quantity * (s.price - s.previousClose)),
      price_source: 'KIS',
      price_as_of: nowIso(),
    };
  });
}

function portfolioResponse(a: MockAccount) {
  const positions = buildPositions(a);
  const sum = (key: 'purchase_amount' | 'evaluation_amount' | 'unrealized_profit' | 'today_profit') =>
    positions.reduce((total, p) => total + Number(p[key]), 0);
  const totalPurchase = sum('purchase_amount');
  const totalEval = sum('evaluation_amount');
  const unrealized = sum('unrealized_profit');
  const realized = 128_400 * a.performance;
  const totalAssets = totalEval + a.cash_balance;
  const valuationProfit = totalAssets - a.invested_principal + realized;
  const contributions = positions
    .map((p) => ({
      stock_code: p.stock_code,
      stock_name: p.stock_name,
      amount: p.unrealized_profit,
      share_rate: dec((Number(p.unrealized_profit) / unrealized) * 100),
    }))
    .sort((x, y) => Number(y.amount) - Number(x.amount));

  const proposals = positions
    .map((p) => {
      const s = stockByCode(p.stock_code)!;
      const current = Number(p.weight);
      const diff = s.target - current;
      return { p, s, current, diff };
    })
    .filter(({ diff }) => Math.abs(diff) >= 0.3)
    .slice(0, 5)
    .map(({ p, s, current, diff }) => ({
      proposal_key: `${a.id}:${p.stock_code}:${isoDate(today())}`,
      stock_code: p.stock_code,
      stock_name: p.stock_name,
      current_weight: dec(current),
      target_weight: dec(s.target),
      weight_diff: dec(diff),
      action: diff > 0 ? 'BUY' : 'SELL',
      recommended_amount: dec(Math.abs((diff / 100) * totalEval), 0),
    }))
    .filter((proposal) => !state.decisions.some((d) => d.proposal_key === proposal.proposal_key));

  return {
    account_id: a.id,
    cash_balance: dec(a.cash_balance),
    total_purchase_amount: dec(totalPurchase),
    total_evaluation_amount: dec(totalEval),
    total_assets: dec(totalAssets),
    unrealized_profit: dec(unrealized),
    realized_profit: dec(realized),
    return_rate: dec((valuationProfit / a.invested_principal) * 100),
    today_profit: dec(sum('today_profit')),
    top_contributor: contributions[0] ?? null,
    contributions,
    strategy_targets_available: true,
    rebalancing_proposals: proposals,
    positions,
    invested_principal: dec(a.invested_principal),
    valuation_profit: dec(valuationProfit),
    withdrawable_amount: dec(totalAssets),
    settlement_mode: 'VIRTUAL',
  };
}

function fundSummary(a: MockAccount) {
  const p = portfolioResponse(a);
  return {
    account_id: a.id,
    settlement_mode: 'VIRTUAL',
    invested_principal: p.invested_principal,
    cash_balance: p.cash_balance,
    position_evaluation_amount: p.total_evaluation_amount,
    total_assets: p.total_assets,
    valuation_profit: p.valuation_profit,
    return_rate: p.return_rate,
    withdrawable_amount: p.withdrawable_amount,
    valuation_as_of: nowIso(),
  };
}

const PERIOD_DAYS: Record<string, number> = { '1M': 22, '3M': 63, '1Y': 250, ALL: 125 };

/** 포트폴리오/벤치마크 누적 수익률 곡선 — 마지막 값이 finalRate가 되도록 맞춘다 */
function returnCurve(points: number, finalRate: number, seed: number, volatility = 0.9) {
  const rand = seeded(seed);
  const walk: number[] = [0];
  for (let i = 1; i < points; i += 1) walk.push(walk[i - 1] + (rand() - 0.47) * volatility);
  const last = walk[points - 1];
  return walk.map((v, i) => v + ((finalRate - last) * i) / Math.max(1, points - 1));
}

function historyResponse(a: MockAccount, period: string) {
  const p = portfolioResponse(a);
  const finalRate = Number(p.return_rate);
  const count = PERIOD_DAYS[period] ?? 63;
  const days = businessDays(count);
  const scale = period === '1M' ? 0.35 : period === '3M' ? 0.6 : 1;
  const port = returnCurve(count, finalRate * scale, hash(a.id + period), 1.6);
  const bench = returnCurve(count, finalRate * scale * 0.48, hash('kospi' + period), 0.8);
  const totalAssets = Number(p.total_assets);
  return {
    account_id: a.id,
    period,
    benchmark_name: 'KOSPI',
    items: days.map((d, i) => ({
      date: isoDate(d),
      total_assets: dec(totalAssets / (1 + finalRate * scale / 100) * (1 + port[i] / 100)),
      portfolio_return_rate: dec(port[i]),
      benchmark_return_rate: dec(bench[i]),
    })),
  };
}

function ordersAndExecutions(a: MockAccount) {
  const rand = seeded(hash(a.id));
  const start = new Date(a.created_at);
  const orders: Array<Record<string, Json>> = [];
  const executions: Array<Record<string, Json>> = [];
  const positions = buildPositions(a);
  let execId = 1;
  // 최초 매수
  positions.forEach((p, i) => {
    const at = addDays(start, 1);
    at.setHours(9, 2 + i, 0, 0);
    const id = `ord-${a.id}-init-${i}`;
    orders.push({
      id, account_id: a.id, stock_code: p.stock_code, side: 'BUY', order_type: 'MARKET',
      quantity: p.quantity, status: 'FILLED', requested_price: p.average_price, requested_at: at.toISOString(),
    });
    executions.push({
      id: execId++, order_id: id, stock_code: p.stock_code, stock_name: p.stock_name, side: 'BUY',
      quantity: p.quantity, execution_price: p.average_price, executed_at: at.toISOString(),
    });
  });
  // 월간 리밸런싱 거래
  for (let m = 1; m <= 5; m += 1) {
    for (let k = 0; k < 3; k += 1) {
      const p = positions[Math.floor(rand() * positions.length)];
      const side = rand() > 0.5 ? 'BUY' : 'SELL';
      const at = addDays(start, m * 30 + k);
      at.setHours(9, 10 + k * 7, 0, 0);
      const id = `ord-${a.id}-rb-${m}-${k}`;
      const qty = Math.max(1, Math.round(Number(p.quantity) * 0.15));
      const price = Number(p.current_price) * (0.9 + rand() * 0.15);
      orders.push({
        id, account_id: a.id, stock_code: p.stock_code, side, order_type: 'MARKET',
        quantity: dec(qty, 0), status: 'FILLED', requested_price: dec(price, 0), requested_at: at.toISOString(),
      });
      executions.push({
        id: execId++, order_id: id, stock_code: p.stock_code, stock_name: p.stock_name, side,
        quantity: dec(qty, 0), execution_price: dec(price, 0), executed_at: at.toISOString(),
      });
    }
  }
  const extra = state.extraOrders.filter((o) => o.account_id === a.id);
  extra.forEach((o) => {
    orders.push(o);
    executions.push({
      id: execId++, order_id: o.id, stock_code: o.stock_code, stock_name: stockByCode(String(o.stock_code))?.name ?? null,
      side: o.side, quantity: o.quantity, execution_price: o.requested_price, executed_at: o.requested_at,
    });
  });
  const desc = (x: Record<string, Json>, y: Record<string, Json>, key: string) =>
    String(y[key]).localeCompare(String(x[key]));
  return {
    orders: orders.sort((x, y) => desc(x, y, 'requested_at')),
    executions: executions.sort((x, y) => desc(x, y, 'executed_at')),
  };
}

function decisionsResponse(a: MockAccount) {
  const seededHistory = [
    { stock: STOCKS[1], action: 'SELL', decision: 'ACCEPTED', daysAgo: 34, outcome: '2.84' },
    { stock: STOCKS[4], action: 'BUY', decision: 'ACCEPTED', daysAgo: 64, outcome: '1.92' },
    { stock: STOCKS[3], action: 'BUY', decision: 'HELD', daysAgo: 95, outcome: '-0.48' },
    { stock: STOCKS[10], action: 'SELL', decision: 'ACCEPTED', daysAgo: 126, outcome: '1.15' },
  ].map(({ stock, action, decision, daysAgo, outcome }, i) => ({
    id: `dec-${a.id}-${i}`,
    account_id: a.id,
    proposal_key: `${a.id}:${stock.code}:past-${i}`,
    strategy_id: a.selected_strategy_id,
    stock_code: stock.code,
    stock_name: stock.name,
    action,
    current_weight: dec(stock.weight + (action === 'SELL' ? 1.8 : -1.2)),
    target_weight: dec(stock.target),
    weight_diff: dec(action === 'SELL' ? -1.8 : 1.2),
    recommended_amount: dec(180_000 + i * 42_000, 0),
    decision,
    baseline_snapshot_date: isoDate(addDays(today(), -daysAgo)),
    actual_portfolio_return_rate: outcome,
    outcome_as_of: isoDate(today()),
    created_at: addDays(today(), -daysAgo).toISOString(),
  }));
  const items = [...state.decisions.filter((d) => d.account_id === a.id), ...seededHistory];
  return {
    account_id: a.id,
    period_label: '최근 6개월',
    proposed: items.length + 2,
    accepted: items.filter((d) => d.decision === 'ACCEPTED').length,
    held: items.filter((d) => d.decision === 'HELD').length,
    items,
  };
}

function stockSummary(code: string) {
  const s = stockByCode(code);
  const info = s ? STOCK_INFO[s.name] : null;
  const price = s?.price ?? 50_000;
  const prev = s?.previousClose ?? price;
  const capTrillion = info ? parseNumber(info.cap) ?? 10 : 10;
  return {
    stock_code: code,
    stock_name: s?.name ?? code,
    market: 'KOSPI',
    sector: s?.sector ?? null,
    listing_date: '1975-06-11',
    listed_shares: Math.round((capTrillion * 1e12) / price),
    security_type: '보통주',
    description: info?.desc ?? null,
    price: dec(price),
    previous_close: dec(prev),
    change_amount: dec(price - prev),
    change_rate: dec(s?.changeRate ?? 0),
    volume: 1_000_000 + (hash(code) % 9_000_000),
    market_cap: dec(capTrillion * 1e12, 0),
    per: info ? dec(parseNumber(info.per) ?? 0) : null,
    pbr: info ? dec(parseNumber(info.pbr) ?? 0) : null,
    roe: info ? dec(parseNumber(info.roe) ?? 0) : null,
    dividend_yield: info ? dec(parseNumber(info.div) ?? 0) : null,
    financial_year: '2025',
    as_of: nowIso(),
    sources: { price: 'KIS', financials: 'OpenDART', profile: 'KRX' },
  };
}

const CHART_POINTS: Record<string, number> = { '1D': 78, '1W': 35, '3M': 63, '6M': 125, '1Y': 250, '5Y': 260 };

function stockChart(code: string, period: string) {
  const s = stockByCode(code);
  const price = s?.price ?? 50_000;
  const count = CHART_POINTS[period] ?? 63;
  const rand = seeded(hash(code + period));
  const drift = period === '5Y' ? 0.55 : period === '1Y' ? 0.25 : period === '1D' ? 0.01 : 0.12;
  const curve = returnCurve(count, drift * 100, hash(code + period), period === '1D' ? 0.15 : 1.6);
  const base = price / (1 + curve[count - 1] / 100);
  let times: Date[];
  if (period === '1D') {
    const open = today();
    open.setHours(9, 0, 0, 0);
    times = Array.from({ length: count }, (_, i) => new Date(open.getTime() + i * 5 * 60_000));
  } else if (period === '1W') {
    times = businessDays(5).flatMap((d) =>
      Array.from({ length: 7 }, (_, h) => { const t = new Date(d); t.setHours(9 + h, 0, 0, 0); return t; }));
  } else if (period === '5Y') {
    times = Array.from({ length: count }, (_, i) => addDays(today(), -7 * (count - 1 - i)));
  } else {
    times = businessDays(count);
  }
  return {
    stock_code: code,
    period,
    source: 'KRX',
    as_of: nowIso(),
    items: times.map((t, i) => {
      const close = base * (1 + curve[i] / 100);
      const spread = close * (0.004 + rand() * 0.012);
      const open = close + (rand() - 0.5) * spread;
      return {
        date: period === '1D' || period === '1W' ? t.toISOString() : isoDate(t),
        open: dec(open, 0),
        high: dec(Math.max(open, close) + spread * rand(), 0),
        low: dec(Math.min(open, close) - spread * rand(), 0),
        close: dec(i === count - 1 ? price : close, 0),
        volume: 300_000 + Math.floor(rand() * 4_000_000),
      };
    }),
  };
}

function stockEvaluation(accountId: string, code: string) {
  const s = stockByCode(code);
  const ai = s ? STOCK_INFO[s.name].ai : [70, 70, 70, 70, 70];
  const axes = [
    ['stability', '안정성', '최근 1년 가격 변동성과 최대 낙폭'],
    ['financial_health', '재무 건전성', '부채비율·유동비율 등 재무제표 지표'],
    ['growth', '성장성', '매출·영업이익 3개년 성장률'],
    ['defense', '방어력', '시장 하락 구간의 상대 수익률'],
    ['diversification', '분산 기여', '포트폴리오 내 다른 종목과의 상관관계'],
  ] as const;
  return {
    account_id: accountId,
    stock_code: code,
    stock_name: s?.name ?? null,
    feature_version: 'stock-feature-v1',
    as_of: isoDate(today()),
    target_weight: s ? dec(s.target) : null,
    role_summary: s?.why ?? null,
    axes: axes.map(([key, label, basis], i) => ({ key, label, score: ai[i], status: 'AVAILABLE', basis })),
    sources: ['KRX', 'OpenDART', 'Portfolio'],
  };
}

function comparisonResponse(period: string) {
  const ai = state.accounts.AUTO;
  const my = state.accounts.SEMI_AUTO;
  const aiP = portfolioResponse(ai);
  const myP = portfolioResponse(my);
  const aiRate = Number(aiP.return_rate);
  const myRate = Number(myP.return_rate);
  const baseline = isoDate(new Date(ai.created_at));
  const account = (a: MockAccount, p: ReturnType<typeof portfolioResponse>) => ({
    account_id: a.id,
    account_name: a.account_name,
    operation_mode: a.operation_mode,
    strategy_id: a.selected_strategy_id,
    baseline_assets: dec(a.invested_principal),
    current_assets: p.total_assets,
    return_rate: p.return_rate,
  });
  return {
    comparison_status: 'AVAILABLE',
    period,
    baseline_date: baseline,
    as_of: isoDate(today()),
    observation_count: PERIOD_DAYS[period] ?? 63,
    accounts: { ai_auto: account(ai, aiP), my_investment: account(my, myP) },
    metrics: {
      return_rate_gap: dec(aiRate - myRate),
      asset_gap: dec(Number(aiP.total_assets) - Number(myP.total_assets)),
      leader: aiRate > myRate ? 'AI_AUTO' : aiRate < myRate ? 'MY_INVESTMENT' : 'TIE',
    },
    ai_analysis: {
      status: 'AVAILABLE',
      headline: `AI 자동투자가 ${Math.abs(aiRate - myRate).toFixed(1)}%p 앞서고 있어요`,
      summary:
        'AI 자동투자 계좌는 반도체 비중을 목표치에 맞춰 제때 줄이면서 상승분을 지켰고, 직접 운용한 계좌는 일부 리밸런싱 제안을 보류해 변동성이 조금 더 컸어요.',
      key_points: [
        'SK하이닉스 비중 축소 제안을 수락한 시점이 수익률 차이의 가장 큰 원인이었어요.',
        '두 계좌 모두 KOSPI 대비 높은 수익률을 기록하고 있어요.',
        '직접 운용 계좌는 현금 비중이 더 높아 하락 구간에서 손실이 작았어요.',
      ],
      caution: '과거 성과가 미래 수익을 보장하지 않아요. 비교 기간이 짧으면 결과가 달라질 수 있어요.',
      model_version: 'comparison-analyst-v1',
      generated_at: nowIso(),
    },
  };
}

function recommendationSnapshot(kind: 'momentum' | 'loss') {
  const picks = kind === 'momentum'
    ? ['000660', '005930', '005380', '000270', '105560', '086790', '035420', '000810']
    : ['005930', '033780', '017670', '105560', '055550', '000810', '051900', '271560'];
  const weights = [18, 16, 14, 12, 11, 10, 10, 9];
  return {
    as_of: isoDate(today()),
    generated_at: nowIso(),
    model_version: kind === 'momentum' ? 'momentum-ranker-v2.1' : 'Algorithm(ver.2.4)_fix2',
    data_version: `krx-${isoDate(today())}`,
    status: 'ready',
    market_regime: 'neutral',
    source: 'generated',
    is_stale: false,
    recommendations: picks.map((code, i) => {
      const s = stockByCode(code)!;
      return {
        symbol: code,
        stock_name: s.name,
        score: Number((0.92 - i * 0.04).toFixed(2)),
        rank: i + 1,
        target_weight: weights[i] / 100,
        reason: s.why,
      };
    }),
  };
}

function investorProfile(answers?: Array<{ question_id: string; option_id: string }>) {
  let score = 52;
  if (answers?.length) {
    const ratio = answers.reduce((sum, a) => {
      const q = RISK_QUESTIONS.find((x) => x.id === a.question_id);
      const idx = q ? q.options.findIndex((o) => o.id === a.option_id) : 0;
      return sum + (q ? idx / Math.max(1, q.options.length - 1) : 0.5);
    }, 0) / answers.length;
    score = Math.round(15 + ratio * 75);
  }
  const types = [
    ['안정추구형', '원금을 지키는 것이 가장 중요해요', '손실 가능성을 최소화하고 예금보다 조금 높은 수익을 목표로 해요.'],
    ['안정투자형', '안정 속에서 조금의 수익을 더해요', '큰 손실은 피하면서 꾸준한 수익을 기대하는 투자 스타일이에요.'],
    ['중립투자형', '위험과 수익의 균형을 추구해요', '어느 정도의 가격 변동은 감수하면서 시장 평균 이상의 수익을 기대해요.'],
    ['성장추구형', '더 높은 수익을 위해 변동을 감수해요', '장기적으로 자산을 키우기 위해 단기 손실을 견딜 수 있는 편이에요.'],
    ['공격투자형', '높은 수익을 적극적으로 추구해요', '큰 변동성도 감수하며 시장보다 높은 수익을 목표로 하는 투자 스타일이에요.'],
  ] as const;
  const idx = Math.min(4, Math.floor(score / 20));
  const [profile_type, tendency_line, description] = types[idx];
  const trait = (v: number) => Math.max(1, Math.min(5, Math.round(v)));
  return {
    assessment_id: 'assess-0001',
    questionnaire_version: 'v1',
    analysis_version: 'v2',
    risk_score: score,
    profile_type,
    tendency_line,
    description,
    traits: { stability: trait(5 - score / 25), return_seeking: trait(score / 20 + 0.5), horizon: 4 },
    analysis_summary: [
      '투자 기간이 3년 이상으로 길어 단기 변동을 견딜 여유가 있어요.',
      '손실 감내 수준이 보통이라 하락장 방어 전략과 잘 맞아요.',
      '투자 경험이 있어 리밸런싱 제안을 직접 판단할 수 있어요.',
    ],
    model_version: 'investor-profile-v2',
    created_at: addDays(today(), -14).toISOString(),
  };
}

function backtestResult(body: Record<string, string>) {
  const start = body.startDate;
  const end = body.endDate;
  const strategyId = body.strategyId;
  const years = Math.max(0.1, (new Date(end).getTime() - new Date(start).getTime()) / (365.25 * 86_400_000));
  const crash = body.periodId === 'corona-crash' || /2022/.test(body.periodId ?? '');
  const annual = strategyId === 'momentum' ? 14.1 : 10.2;
  const final = crash ? (strategyId === 'momentum' ? -12.4 : -6.8) : ((1 + annual / 100) ** years - 1) * 100;
  const benchFinal = crash ? -24.6 : final * 0.52;
  const points = 60;
  const strat = returnCurve(points, final, hash(strategyId + body.periodId), strategyId === 'momentum' ? 7 : 5);
  const bench = returnCurve(points, benchFinal, hash('kospi' + body.periodId), 6);
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const mdd = (curve: number[]) => {
    let peak = -Infinity;
    let worst = 0;
    curve.forEach((v) => {
      const level = 1 + v / 100;
      peak = Math.max(peak, level);
      worst = Math.min(worst, (level / peak - 1) * 100);
    });
    return Number(worst.toFixed(1));
  };
  const growth = 1 + final / 100;
  return {
    strategyId,
    strategyName: strategyId === 'momentum' ? '모멘텀 전략' : '물림방지 전략',
    period: {
      id: body.periodId, label: body.periodLabel, startDate: start, endDate: end, description: body.periodDescription,
    },
    series: strat.map((v, i) => ({
      t: new Date(startMs + ((endMs - startMs) * i) / (points - 1)).toISOString().slice(0, 10),
      strategy: Number(v.toFixed(2)),
      benchmark: Number(bench[i].toFixed(2)),
    })),
    metrics: {
      cumulativeReturn: Number(final.toFixed(1)),
      cagr: Number(((growth > 0 ? growth ** (1 / years) : 0) * 100 - 100).toFixed(1)),
      mdd: mdd(strat),
      volatility: strategyId === 'momentum' ? 21.3 : 12.4,
      sharpe: strategyId === 'momentum' ? 0.66 : 0.82,
    },
    benchmarkName: 'KOSPI',
    benchmarkMetrics: { cumulativeReturn: Number(benchFinal.toFixed(1)), mdd: mdd(bench) },
  };
}

function backtestExplanation(ctx: Record<string, Json>) {
  const diff = Number(ctx.benchmarkDifference ?? 0);
  return {
    headline: diff >= 0
      ? `${ctx.benchmarkName}보다 ${Math.abs(diff)}%p 높은 성과를 냈어요`
      : `${ctx.benchmarkName}보다 ${Math.abs(diff)}%p 낮았지만 낙폭은 작았어요`,
    overview: `${ctx.periodLabel} 동안 ${ctx.strategyName}은 누적 ${ctx.cumulativeReturn}%를 기록했어요. 변동성이 큰 종목의 비중을 줄이고 재무가 안정적인 종목을 중심으로 담아, 시장이 흔들릴 때도 손실 폭을 줄였어요.`,
    caution: `이 기간 최대 낙폭은 ${ctx.mdd}%였어요. 과거 성과가 미래 수익을 보장하지 않으니 투자 기간과 목표를 함께 고려해주세요.`,
    generatedAt: nowIso(),
  };
}

const NEWS = [
  ['코스피, 반도체 강세에 2,900선 회복…외국인 순매수 전환', '외국인 투자자가 사흘 만에 순매수로 돌아서면서 반도체 대형주를 중심으로 지수가 상승했다.', '한국경제'],
  ['SK하이닉스, HBM4 양산 앞당긴다…AI 서버 수요 대응', 'SK하이닉스가 차세대 고대역폭메모리 양산 일정을 앞당기며 AI 반도체 시장 주도권 굳히기에 나섰다.', '매일경제'],
  ['한은, 기준금리 동결…"물가 둔화 흐름 지켜볼 것"', '한국은행 금융통화위원회가 기준금리를 현 수준에서 동결하고 향후 물가 흐름을 점검하기로 했다.', '연합뉴스'],
  ['현대차·기아, 3분기 미국 판매 역대 최대…하이브리드 효과', '하이브리드 차량 판매 호조에 힘입어 현대차그룹의 미국 시장 분기 판매량이 사상 최대를 기록했다.', '조선비즈'],
  ['금융지주 배당 확대 기대감…밸류업 공시 잇따라', '주요 금융지주가 주주환원 확대 계획을 담은 기업가치 제고 계획을 연이어 공시했다.', '서울경제'],
  ['네이버, 생성형 AI 검색 고도화…광고 매출 반등 기대', '네이버가 검색 서비스에 생성형 AI 기능을 확대 적용하면서 광고 부문 실적 개선 기대가 커지고 있다.', '전자신문'],
  ['원·달러 환율 1,350원대 안정…수출주 부담 완화', '달러 강세가 진정되면서 원·달러 환율이 1,350원대에서 안정적인 흐름을 이어가고 있다.', '머니투데이'],
  ['셀트리온, 유럽서 바이오시밀러 신규 허가 획득', '셀트리온이 유럽 의약품청으로부터 자가면역질환 치료제 바이오시밀러의 판매 허가를 받았다.', '헤럴드경제'],
  ['개인투자자 ETF 순매수 1위는 배당주…"변동성 대비"', '최근 한 달간 개인투자자의 ETF 순매수 상위권에 고배당 상품이 다수 이름을 올렸다.', '이데일리'],
  ['POSCO홀딩스, 이차전지 소재 투자 속도 조절', 'POSCO홀딩스가 전기차 수요 둔화에 대응해 이차전지 소재 설비 투자 일정을 일부 조정한다.', '아시아경제'],
];

function newsResponse() {
  const items = NEWS.map(([title, summary, publisher], i) => ({
    id: `news-${i + 1}`,
    title,
    summary,
    publisher,
    publishedAt: new Date(Date.now() - (i * 2 + 1) * 3_600_000).toISOString(),
    link: 'https://finance.naver.com/news/',
  }));
  return { items, totalCount: items.length, updatedAt: nowIso() };
}

function chatResponse(message: string) {
  const text = /리밸런싱/.test(message)
    ? '리밸런싱은 시간이 지나 달라진 종목 비중을 원래 목표 비중으로 되돌리는 거예요. 지금 포트폴리오에서는 SK하이닉스가 목표보다 2%p 정도 커서 일부 매도를 제안드리고 있어요.'
    : /수익|성과/.test(message)
      ? '현재 포트폴리오는 투자 원금 대비 약 9% 수익을 내고 있어요. 반도체와 금융 업종이 수익에 가장 크게 기여했어요.'
      : `좋은 질문이에요! "${message}"에 대해 말씀드리면, FE!N은 투자 성향과 시장 데이터를 함께 분석해 위험을 줄이면서 꾸준한 수익을 낼 수 있도록 포트폴리오를 관리해요.`;
  return {
    message_id: uuid(),
    status: 'COMPLETED',
    text,
    caution: '이 답변은 투자 권유가 아니며, 투자 판단의 책임은 본인에게 있어요.',
    suggested_questions: ['지금 리밸런싱이 필요한가요?', '가장 수익이 좋은 종목은?', '물림방지 전략은 어떻게 동작하나요?'],
    model_version: 'fein-chat-v1',
    generated_at: nowIso(),
  };
}

function onboarding(body: Record<string, Json>, status = 'COMPLETED') {
  const mode = (body.operation_mode as Mode) ?? 'SEMI_AUTO';
  return {
    id: 'onb-0001',
    strategy_id: String(body.strategy_id ?? 'low'),
    investment_amount: dec(Number(body.investment_amount ?? 10_000_000)),
    operation_mode: mode,
    status,
    account_id: state.accounts[mode].id,
    terms_completed: true,
    account_exists: true,
    next_step: status === 'COMPLETED' ? 'PORTFOLIO' : 'CONFIRM',
    completed_at: status === 'COMPLETED' ? nowIso() : null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function fundOperation(a: MockAccount, type: 'ADDITIONAL_INVESTMENT' | 'WITHDRAWAL', amount: number) {
  const before = a.invested_principal;
  a.invested_principal += type === 'WITHDRAWAL' ? -amount : amount;
  saveState();
  return {
    operation_id: uuid(),
    type,
    status: 'COMPLETED',
    settlement_mode: 'VIRTUAL',
    requested_amount: dec(amount),
    executed_amount: dec(amount),
    principal_before: dec(before),
    principal_after: dec(a.invested_principal),
    portfolio: fundSummary(a),
    trades: buildPositions(a).slice(0, 5).map((p) => ({
      order_id: uuid(),
      stock_code: p.stock_code,
      side: type === 'WITHDRAWAL' ? 'SELL' : 'BUY',
      applied_weight: p.weight,
      quantity: dec(Math.max(1, Math.round((amount * Number(p.weight)) / 100 / Number(p.current_price))), 0),
      execution_price: p.current_price,
      transaction_amount: dec((amount * Number(p.weight)) / 100, 0),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 라우터                                                               */
/* ------------------------------------------------------------------ */

class MockError {
  constructor(public status: number, public code: string, public message: string) {}
}

const TERMS = [
  { term_code: 'SERVICE', version: '1.0', title: '서비스 이용약관', is_required: true },
  { term_code: 'PRIVACY', version: '1.0', title: '개인정보 수집·이용 동의', is_required: true },
  { term_code: 'AI_PERSONALIZATION', version: '1.0', title: 'AI 개인화 분석 동의', is_required: true },
  { term_code: 'MARKETING', version: '1.0', title: '마케팅 정보 수신 동의', is_required: false },
];

function route(method: string, url: URL, body: Record<string, Json>): Json {
  const path = url.pathname.slice(API_PREFIX.length);
  const q = (key: string) => url.searchParams.get(key);
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
  const is = (m: string, pattern: RegExp) => method === m && pattern.test(path);

  // 인증
  if (is('POST', /^\/auth\/login$/)) {
    if (body.user_id) state.user.user_id = String(body.user_id);
    saveState();
    return { access_token: 'mock-access-token', token_type: 'bearer' };
  }
  if (is('GET', /^\/auth\/me$/)) return state.user;
  if (is('POST', /^\/auth\/logout$/)) return undefined;
  if (is('GET', /^\/auth\/terms$/)) return TERMS;
  if (is('POST', /^\/auth\/signup$/)) {
    state.user = { ...state.user, user_id: String(body.user_id), name: String(body.name), email: String(body.email) };
    saveState();
    return state.user;
  }
  if (is('POST', /^\/auth\/email-verifications\/send$/))
    return { verification_id: uuid(), expires_in_seconds: 300, resend_after_seconds: 30 };
  if (is('POST', /^\/auth\/email-verifications\/verify$/))
    return { verification_token: uuid(), expires_in_seconds: 600 };

  // 전략
  if (is('GET', /^\/strategies$/))
    return [
      { id: 'low', name: '물림방지 전략', description: '큰 손실을 피하면서 안정적인 투자를 지향하는 FE!N의 자체 전략입니다.', risk_level: 'MEDIUM', rebalance_cycle: 'MONTHLY' },
      { id: 'value', name: '가치 전략', description: '이익이나 자산 대비 저평가된 종목을 담는 전략이에요.', risk_level: 'MEDIUM', rebalance_cycle: 'QUARTERLY' },
      { id: 'momentum', name: '모멘텀 전략', description: '최근 가격 흐름이 강한 종목의 움직임을 활용하는 전략이에요.', risk_level: 'HIGH', rebalance_cycle: 'MONTHLY' },
    ];

  // 계좌
  if (is('GET', /^\/accounts\/me$/)) return accountResponse(state.accounts[(q('operation_mode') as Mode) ?? 'SEMI_AUTO']);
  if (is('POST', /^\/accounts$/)) return accountResponse(state.accounts[(body.operation_mode as Mode) ?? 'SEMI_AUTO']);
  if (is('POST', /^\/accounts\/[^/]+\/deposits$/)) {
    const a = accountById(seg[1]);
    const amount = Number(body.amount);
    a.cash_balance += amount;
    a.invested_principal += amount;
    saveState();
    return { deposit_id: uuid(), account: accountResponse(a), amount: dec(amount), balance_after: dec(a.cash_balance), status: 'COMPLETED' };
  }
  if (is('GET', /^\/accounts\/[^/]+\/funds$/)) return fundSummary(accountById(seg[1]));
  if (is('POST', /^\/accounts\/[^/]+\/additional-investments$/))
    return fundOperation(accountById(seg[1]), 'ADDITIONAL_INVESTMENT', Number(body.amount));
  if (is('POST', /^\/accounts\/[^/]+\/withdrawals$/))
    return fundOperation(accountById(seg[1]), 'WITHDRAWAL', Number(body.amount));
  if (is('PUT', /^\/accounts\/[^/]+\/strategy$/)) {
    const a = accountById(seg[1]);
    a.selected_strategy_id = String(body.strategy_id);
    saveState();
    return accountResponse(a);
  }

  // 목표 차량
  if (is('GET', /^\/me\/car-goal$/)) {
    if (!state.carGoal) throw new MockError(404, 'CAR_GOAL_NOT_SET', '목표 차량이 설정되지 않았습니다.');
    const assets = portfolioResponse(state.accounts.SEMI_AUTO).total_assets;
    return { ...state.carGoal, goal_amount: dec(state.carGoal.goal_amount), current_amount: assets };
  }
  if (is('PUT', /^\/me\/car-goal$/)) {
    state.carGoal = { car_grade: body.car_grade as 'INEX' | 'HIGHEND', goal_amount: Number(body.goal_amount), updated_at: nowIso() };
    saveState();
    const assets = portfolioResponse(state.accounts.SEMI_AUTO).total_assets;
    return { ...state.carGoal, goal_amount: dec(state.carGoal.goal_amount), current_amount: assets };
  }

  // 투자 온보딩
  if (is('GET', /^\/investment\/terms$/))
    return [
      { term_code: 'INVEST_RISK', version: '1.0', title: '투자위험 고지 확인', is_required: true, content_reference: null },
      { term_code: 'VIRTUAL_TRADING', version: '1.0', title: '가상 투자 서비스 이용 동의', is_required: true, content_reference: null },
    ];
  if (is('POST', /^\/investment\/onboardings$/)) {
    const mode = (body.operation_mode as Mode) ?? 'SEMI_AUTO';
    state.accounts[mode].selected_strategy_id = String(body.strategy_id);
    saveState();
    return onboarding(body, 'READY');
  }
  if (is('POST', /^\/investment\/onboardings\/[^/]+\/agreements$/)) return onboarding({}, 'READY');
  if (is('POST', /^\/investment\/onboardings\/[^/]+\/account$/))
    return { account: accountResponse(state.accounts.SEMI_AUTO), created: false, required_deposit_amount: '0', onboarding: onboarding({}, 'READY') };
  if (is('POST', /^\/investment\/onboardings\/[^/]+\/deposit$/))
    return { deposit_id: uuid(), amount: dec(Number(body.amount)), balance_after: dec(state.accounts.SEMI_AUTO.cash_balance), required_deposit_amount: '0', onboarding: onboarding({}, 'READY') };
  if (is('POST', /^\/investment\/onboardings\/[^/]+\/complete$/)) return onboarding({});

  // 시세
  if (is('GET', /^\/market\/stocks\/[^/]+\/price$/)) {
    const summary = stockSummary(seg[2]);
    return {
      stock_code: seg[2], price: summary.price, previous_close: summary.previous_close,
      change_amount: summary.change_amount, change_rate: summary.change_rate, volume: summary.volume,
      source: 'KIS', as_of: nowIso(),
    };
  }
  if (is('GET', /^\/market\/stocks\/[^/]+\/summary$/)) return stockSummary(seg[2]);
  if (is('GET', /^\/market\/stocks\/[^/]+\/chart$/)) return stockChart(seg[2], q('period') ?? '3M');

  // 포트폴리오
  if (is('GET', /^\/portfolio$/)) return portfolioResponse(accountById(q('account_id')));
  if (is('GET', /^\/portfolio\/history$/)) return historyResponse(accountById(q('account_id')), q('period') ?? '3M');
  if (is('GET', /^\/portfolio\/comparison$/)) return comparisonResponse(q('period') ?? '3M');
  if (is('GET', /^\/portfolio\/stock-evaluation$/)) return stockEvaluation(q('account_id') ?? '', q('stock_code') ?? '');
  if (is('GET', /^\/portfolio\/decisions$/)) return decisionsResponse(accountById(q('account_id')));
  if (is('POST', /^\/portfolio\/decisions$/)) {
    const a = accountById(String(body.account_id));
    const proposal = portfolioResponse(a).rebalancing_proposals.find((p) => p.proposal_key === body.proposal_key);
    const decision = {
      id: uuid(),
      account_id: a.id,
      proposal_key: String(body.proposal_key),
      strategy_id: a.selected_strategy_id,
      stock_code: String(body.stock_code),
      stock_name: stockByCode(String(body.stock_code))?.name ?? null,
      action: proposal?.action ?? 'BUY',
      current_weight: proposal?.current_weight ?? '0',
      target_weight: proposal?.target_weight ?? '0',
      weight_diff: proposal?.weight_diff ?? '0',
      recommended_amount: proposal?.recommended_amount ?? '0',
      decision: body.decision,
      baseline_snapshot_date: isoDate(today()),
      actual_portfolio_return_rate: null,
      outcome_as_of: null,
      created_at: nowIso(),
    };
    state.decisions.unshift(decision);
    saveState();
    return decision;
  }

  // 주문/체결
  if (is('GET', /^\/orders$/)) return ordersAndExecutions(accountById(q('account_id'))).orders;
  if (is('GET', /^\/executions$/)) return ordersAndExecutions(accountById(q('account_id'))).executions;
  if (is('POST', /^\/orders$/)) {
    const s = stockByCode(String(body.stock_code));
    const order = {
      id: uuid(),
      account_id: String(body.account_id),
      stock_code: String(body.stock_code),
      side: body.side,
      order_type: 'MARKET',
      quantity: dec(Number(body.quantity), 0),
      status: 'FILLED',
      requested_price: dec(s?.price ?? 0),
      requested_at: nowIso(),
    };
    state.extraOrders.push(order);
    saveState();
    return order;
  }

  // 투자성향 / 추천
  if (is('POST', /^\/investor-profile\/analyze$/))
    return { ...investorProfile(body.answers as Array<{ question_id: string; option_id: string }>), created_at: nowIso() };
  if (is('GET', /^\/investor-profile\/me\/latest$/)) return investorProfile();
  if (is('POST', /^\/strategy-recommendations$/))
    return {
      recommendation_id: uuid(),
      assessment_id: String(body.assessment_id),
      primary: { strategy_id: 'low', rank: 1, score: 0.92, match_level: 'BEST', reason: '손실 감내 수준이 보통이고 투자 기간이 길어, 하락장을 방어하는 물림방지 전략이 가장 잘 맞아요.', caution: '상승장에서는 시장보다 수익이 낮을 수 있어요.' },
      alternatives: [
        { strategy_id: 'momentum', rank: 2, score: 0.74, match_level: 'GOOD', reason: '장기 투자 성향이라 상승 흐름을 따라가는 전략도 고려해볼 수 있어요.', caution: '방향 전환 시 손실 폭이 커질 수 있어요.' },
      ],
      model_version: 'strategy-recommender-v1',
      dataset_version: 'krx-2026q3',
      recommendation_version: 'v1',
      created_at: nowIso(),
    };
  if (is('GET', /^\/model-recommendations\/latest$/)) return recommendationSnapshot('momentum');
  if (is('GET', /^\/model-recommendations\/loss-avoidance\/latest$/)) return recommendationSnapshot('loss');
  if (method === 'POST' && /^\/model-recommendations\/(loss-avoidance\/)?latest\/(apply|rebalance)$/.test(path))
    return {
      account_id: String(body.account_id),
      strategy_id: path.includes('loss-avoidance') ? 'low' : 'momentum',
      as_of: isoDate(today()),
      target_count: 8,
      orders_created: path.endsWith('rebalance') ? 4 : 8,
      status: 'APPLIED',
    };

  // 챗봇
  if (is('POST', /^\/chat\/messages$/)) return chatResponse(String(body.message ?? ''));

  // 정보 / 백테스트
  if (is('GET', /^\/information\/news\/kr$/)) return newsResponse();
  if (is('GET', /^\/backtest\/available-range$/)) return { minDate: '2015-01-02', maxDate: isoDate(addDays(today(), -1)) };
  if (is('POST', /^\/backtest\/run$/)) return backtestResult(body as Record<string, string>);
  if (is('POST', /^\/backtest\/explain$/)) return backtestExplanation(body);

  throw new MockError(404, 'MOCK_NOT_FOUND', `목업에 정의되지 않은 API예요: ${method} ${path}`);
}

/* ------------------------------------------------------------------ */
/* fetch 가로채기                                                       */
/* ------------------------------------------------------------------ */

const jsonResponse = (status: number, data: Json) =>
  new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export function installMockApi() {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith(API_PREFIX)) {
      return realFetch(input, init);
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let body: Record<string, Json> = {};
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, Json>;
      } catch {
        body = {};
      }
    }
    await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const data = route(method, url, body);
      return jsonResponse(data === undefined ? 204 : 200, data);
    } catch (error) {
      if (error instanceof MockError) return jsonResponse(error.status, { code: error.code, message: error.message });
      console.error('[mock-api]', error);
      return jsonResponse(500, { code: 'MOCK_ERROR', message: '목업 응답을 만들지 못했습니다.' });
    }
  };
  console.info('[mock-api] 목업 API가 활성화됐어요. 초기화: __resetMockApi()');
}
