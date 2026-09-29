// Generated from FastAPI OpenAPI components/schemas. Do not edit by hand.
// Regenerate with: python scripts/generate_api_types.py

export type APIError = {
  code: string;
  messageKey: string;
  diagnostics?: Array<Diagnostic>;
};

export type APIErrorResponse = {
  error: APIError;
};

export type Catalog = {
  version: string;
  parameters?: Array<ParameterDefinition>;
  presets?: Array<PresetDefinition>;
};

export type ContractVersionResponse = {
  apiVersion: string;
  contractVersion: string;
  openapiUrl: string;
};

export type ContributionSettings = {
  day: number;
  amount: string;
};

export type DailyAsset = {
  date: string;
  cash: string;
  timingQuantity: string;
  fixedQuantity: string;
  simulationPrice: string;
  totalAsset: string;
  currency: string;
  unitNav?: string | null;
  drawdown?: string | null;
};

export type DataKind = "market" | "macro" | "valuation";

export type DataRequirement = {
  strategyId: string;
  signalId: string;
  kind: DataKind;
  symbol: string;
  fieldPath: string;
};

export type DataSettings = {
  macroStalenessSessions: number;
  financialFactMaxAgeDays: number;
  etfHoldingsMaxAgeDays: number;
};

export type Diagnostic = {
  code: DiagnosticCode;
  severity?: DiagnosticSeverity;
  messageKey: string;
  fieldPath?: string | null;
  asOf?: string | null;
  source?: string | null;
  details?: unknown;
};

export type DiagnosticCode = "invalid_parameter" | "required_data_unavailable" | "provider_request_failed" | "calculation_failed" | "source_quality_warning" | "stale_data" | "unknown_source_unit" | "price_basis_unavailable" | "no_valid_contribution" | "no_valid_xirr" | "comparison_unavailable" | "invalid_status_transition";

export type DiagnosticSeverity = "info" | "warning" | "error";

export type DraftValidationRequest = {
  draft: {
  [key: string]: unknown;
};
};

export type DraftValidationResponse = {
  valid: boolean;
  sharedSettings?: SharedSettings | null;
  diagnostics?: Array<Diagnostic>;
  strategies?: Array<StrategyValidationResult>;
  dataRequirements?: Array<DataRequirement>;
};

export type EndMode = "fixed" | "latest";

export type ExecutionModule = "accumulation" | "trend" | "scheduled" | "search";

export type ExportKind = "summary" | "daily-assets" | "trades" | "search-results";

export type FrozenRunConfig = {
  shared: SharedSettings;
  strategies?: Array<FrozenStrategyInstance>;
};

export type FrozenStrategyInstance = {
  id: string;
  presetId: StrategyPresetId;
  enabled: boolean;
  params?: unknown;
};

export type HTTPValidationError = {
  detail?: Array<ValidationError>;
};

export type HealthResponse = {
  status: "ok";
};

export type MetricSummary = {
  totalContributed: string;
  endingEquity: string;
  netProfit: string;
  returnOnContributions?: string | null;
  capitalMultiple?: string | null;
  xirr?: string | null;
  maximumDrawdown?: string | null;
  relativeToDca?: string | null;
  currency?: string | null;
  diagnostics?: Array<Diagnostic>;
};

export type ParameterDefinition = {
  key: string;
  type: ParameterType;
  default?: unknown;
  unit?: string | null;
  minimum?: string | null;
  maximum?: string | null;
  step?: string | null;
  allowedValues?: Array<unknown>;
  applicablePresets: Array<StrategyPresetId>;
  searchable?: boolean;
  dependencies?: Array<string>;
  translationKey: string;
  level?: ParameterLevel;
  nullable?: boolean;
};

export type ParameterLevel = "shared" | "strategy" | "preset" | "search" | "ui";

export type ParameterType = "symbol" | "date" | "integer" | "decimal" | "ratio" | "percent_point" | "boolean" | "enum" | "enum_list" | "number_list";

export type PresetDefinition = {
  id: StrategyPresetId;
  nameKey: string;
  descriptionKey: string;
  executionModule: ExecutionModule;
  parameterKeys: Array<string>;
  defaultParams?: unknown;
  searchDimensions?: Array<SearchDimension>;
  supportsBenchmark?: boolean;
};

export type ResultRole = "benchmark" | "strategy";

export type RunDataProvenance = {
  sources?: Array<string>;
  calendarAsOf?: string | null;
  marketDataThrough?: string | null;
};

export type RunProgress = {
  completedStrategies: number;
  totalStrategies: number;
  currentStrategyId?: string | null;
};

export type RunResponse = {
  runId: string;
  status: StrategyStatus;
  selectedStrategyIds: Array<string>;
  progress?: RunProgress | null;
  snapshot: RunSnapshot;
  result?: RunResult | null;
};

export type RunResult = {
  runId: string;
  strategyRuns?: Array<StrategyRun>;
  status?: StrategyStatus;
};

export type RunScope = "active" | "all_enabled";

export type RunSettings = {
  symbol: string;
  startDate: string;
  endDate: string;
  endMode: EndMode;
};

export type RunSnapshot = {
  runId: string;
  config: FrozenRunConfig;
  catalogVersion: string;
  dataFingerprint: string;
  engineVersion: string;
  dataProvenance?: RunDataProvenance;
  createdAt?: string;
};

export type RunSubmissionRequest = {
  draft: {
  [key: string]: unknown;
};
  scope: RunScope;
  activeStrategyId?: string | null;
};

export type SearchCandidate = {
  candidateId: string;
  sequence: number;
  role?: ResultRole;
  status: StrategyStatus;
  calculationFingerprint: string;
  parameterValues: unknown;
  reusedCalculation?: boolean;
  metrics?: MetricSummary | null;
  diagnostics?: Array<Diagnostic>;
};

export type SearchDimension = {
  key: string;
  values: Array<unknown>;
  translationKey?: string;
};

export type SearchResult = {
  strategyId: string;
  dimensions: Array<SearchResultDimension>;
  totalCandidateCount: number;
  candidates: Array<SearchCandidate>;
  rankedCandidateIds: Array<string>;
};

export type SearchResultDimension = {
  key: string;
  values: Array<unknown>;
  translationKey?: string;
};

export type SharedSettings = {
  run: RunSettings;
  contribution: ContributionSettings;
  data: DataSettings;
};

export type SignalEvaluation = {
  date: string;
  signalId: string;
  state: SignalState;
  diagnostics?: Array<Diagnostic>;
};

export type SignalState = "true" | "false" | "unavailable";

export type StrategyPresetId = "vix_dca" | "composite_dca" | "ma_trend" | "ma_buy_only" | "monthly_dca" | "lump_sum" | "grid_search";

export type StrategyRun = {
  id: string;
  presetId: StrategyPresetId;
  role: ResultRole;
  status?: StrategyStatus;
  diagnostics?: Array<Diagnostic>;
  signals?: Array<SignalEvaluation>;
  unexecutedSignals?: Array<UnexecutedSignal>;
  trades?: Array<Trade>;
  dailyAssets?: Array<DailyAsset>;
  metrics?: MetricSummary | null;
  searchResult?: SearchResult | null;
};

export type StrategyStatus = "queued" | "loading" | "running" | "completed" | "completed_with_warning" | "unavailable" | "failed";

export type StrategyValidationResult = {
  strategyId: string;
  presetId: StrategyPresetId;
  enabled: boolean;
  normalized?: FrozenStrategyInstance | null;
  diagnostics?: Array<Diagnostic>;
};

export type Trade = {
  date: string;
  side: TradeSide;
  reason: TradeReason;
  quantity: string;
  price: string;
  cashAmount: string;
  currency: string;
  signalId?: string | null;
};

export type TradeReason = "fixed_dca" | "upfront" | "signal_buy" | "signal_sell" | "safety_valve";

export type TradeSide = "buy" | "sell";

export type UnexecutedSignal = {
  signalDate: string;
  signalId: string;
  reason: UnexecutedSignalReason;
};

export type UnexecutedSignalReason = "no_following_backtest_session";

export type ValidationError = {
  loc: Array<string | number>;
  msg: string;
  type: string;
  input?: unknown;
  ctx?: Record<string, never>;
};
