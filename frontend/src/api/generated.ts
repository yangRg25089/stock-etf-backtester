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

export type AnalysisSettings = {
  riskFreeAnnualRatePct: string;
};

export type Catalog = {
  version: string;
  parameters?: Array<ParameterDefinition>;
  parameterGroups?: Array<ParameterGroupDefinition>;
  presets?: Array<PresetDefinition>;
  conditions?: Array<ConditionDefinition>;
  conditionLimits?: ConditionLimits;
  symbolSuggestions?: Array<SymbolSuggestion>;
  strategyLimits?: StrategyLimits;
};

export type ConditionDefinition = {
  kind: ConditionKind;
  nameKey: string;
  buyParameterKeys: Array<string>;
  sellParameterKeys: Array<string>;
};

export type ConditionGroup = {
  type?: "group";
  id: string;
  enabled?: boolean;
  operator?: ConditionLogic;
  children?: Array<ConditionLeaf | ConditionGroup>;
};

export type ConditionKind = "vix" | "rsi" | "ma_deviation" | "ma_trend" | "bollinger" | "rate";

export type ConditionLeaf = {
  type?: "condition";
  id: string;
  kind: ConditionKind;
  enabled?: boolean;
  params?: {
  [key: string]: unknown;
};
};

export type ConditionLimits = {
  maxDepth?: number;
  maxNodes?: number;
  maxInstancesPerKind?: number;
};

export type ConditionLogic = "AND" | "OR";

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
  simulationOpen?: string | null;
  simulationHigh?: string | null;
  simulationLow?: string | null;
  simulationPrice: string;
  totalAsset: string;
  totalContributed?: string | null;
  actualInvested?: string | null;
  currency: string;
  unitNav?: string | null;
  drawdown?: string | null;
  tradingCosts?: TradingCosts | null;
};

export type DataKind = "market" | "macro";

export type DataRequirement = {
  strategyId: string;
  signalId: string;
  kind: DataKind;
  symbol: string;
  fieldPath: string;
  conditionId?: string | null;
  lookbackSessions?: number;
  periodKey?: string | null;
  sourceUnit?: string | null;
  minimumCoverage?: string | null;
};

export type DataSettings = {
  macroStalenessSessions: number;
};

export type Diagnostic = {
  code: DiagnosticCode;
  severity?: DiagnosticSeverity;
  messageKey: string;
  fieldPath?: string | null;
  asOf?: string | null;
  source?: string | null;
  details?: {
  [key: string]: unknown;
};
};

export type DiagnosticCode = "invalid_parameter" | "required_data_unavailable" | "provider_request_failed" | "calculation_failed" | "source_quality_warning" | "stale_data" | "unknown_source_unit" | "price_basis_unavailable" | "no_valid_contribution" | "no_valid_xirr" | "comparison_unavailable" | "invalid_status_transition" | "run_interrupted" | "run_cancelled";

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

export type DrawdownEpisode = {
  peakDate: string;
  bottomDate: string;
  recoveredDate: string | null;
  endDate: string;
  drawdown: string;
  durationDays: number;
  recoveryDays: number | null;
  state: "recovered" | "ongoing";
};

export type EndMode = "fixed" | "latest";

export type ExecutionModule = "accumulation" | "trend" | "scheduled" | "search";

export type ExecutionSettings = {
  commission: string;
  slippagePct: string;
  spreadPct: string;
  fractionalShares: boolean;
  capitalGainsTaxEnabled?: boolean;
};

export type ExportKind = "summary" | "daily-assets" | "trades" | "search-results";

export type FrozenRunConfig = {
  shared: SharedSettings;
  strategies?: Array<FrozenStrategyInstance>;
};

export type FrozenStrategyInstance = {
  id: string;
  presetId: StrategyPresetId;
  enabled?: boolean;
  instanceNumber?: number | null;
  params?: {
  [key: string]: unknown;
};
  rules?: StrategyRules | null;
};

export type HTTPValidationError = {
  detail?: Array<ValidationError>;
};

export type HealthResponse = {
  status: "ok";
};

export type InstrumentMetadata = {
  symbol: string;
  currency?: string | null;
  diagnostics?: Array<Diagnostic>;
};

export type MetricSummary = {
  totalContributed: string;
  actualInvested?: string | null;
  investmentBasis?: "original_principal" | "buy_turnover" | null;
  endingEquity: string;
  netProfit: string;
  returnOnContributions?: string | null;
  capitalMultiple?: string | null;
  xirr?: string | null;
  maximumDrawdown?: string | null;
  currency?: string | null;
  diagnostics?: Array<Diagnostic>;
  analysis?: PerformanceAnalysis | null;
  tradingCosts?: TradingCosts | null;
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
  pattern?: string | null;
  groupId: string;
};

export type ParameterGroupDefinition = {
  id: string;
  translationKey: string;
};

export type ParameterLevel = "shared" | "strategy" | "preset" | "search" | "ui";

export type ParameterType = "symbol" | "date" | "integer" | "decimal" | "ratio" | "percent_point" | "boolean" | "enum" | "enum_list" | "number_list";

export type PerformanceAnalysis = {
  analysisMethod: "unit-nav-v1";
  tradingDaysPerYear: 252;
  durationUnit: "calendar_days";
  riskFreeAnnualRate: string;
  annualizedReturn?: string | null;
  annualizedVolatility?: string | null;
  sharpeRatio?: string | null;
  sortinoRatio?: string | null;
  calmarRatio?: string | null;
  maximumDrawdownDuration?: number | null;
  recoveryDuration?: number | null;
  buyCount: number;
  sellCount: number;
  turnover?: string | null;
  averageCashRatio?: string | null;
  unavailableReasons?: {
  [key: string]: string;
};
  annualReturns?: Array<PeriodReturn> | null;
  monthlyReturns?: Array<PeriodReturn> | null;
  drawdownEpisodes?: Array<DrawdownEpisode> | null;
};

export type PeriodReturn = {
  year: number;
  month?: number | null;
  startDate: string;
  endDate: string;
  navReturn: string | null;
  priceReturn: string;
  unavailableReason?: "no_funding" | "missing_nav" | "undefined_nav" | null;
};

export type PresetDefinition = {
  id: StrategyPresetId;
  nameKey: string;
  descriptionKey: string;
  executionModule: ExecutionModule;
  parameterKeys: Array<string>;
  defaultParams?: unknown;
  searchDimensions?: Array<SearchDimension>;
  supportsBenchmark?: boolean;
  editorMode?: "fixed" | "custom" | "search";
  defaultRules?: StrategyRules | null;
};

export type ResultRole = "benchmark" | "strategy";

export type RunDataContext = {
  dataFingerprint: string;
  dataProvenance?: RunDataProvenance;
  effectiveRun: RunSettings;
  dateAdjustments?: Array<RunDateAdjustment>;
};

export type RunDataProvenance = {
  sources?: Array<string>;
  calendarAsOf?: string | null;
  marketDataThrough?: string | null;
};

export type RunDateAdjustment = {
  field: "startDate" | "endDate";
  requestedDate: string;
  effectiveDate: string;
  reason: "market_available_from" | "indicator_warmup";
};

export type RunProgress = {
  completedStrategies: number;
  totalStrategies: number;
  currentStrategyId?: string | null;
};

export type RunProgressEvent = {
  runId: string;
  status: StrategyStatus;
  progress: RunProgress | null;
  strategyStatuses: {
  [key: string]: StrategyStatus;
};
  strategySummaries?: {
  [key: string]: RunStrategySummary;
};
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
  endMode?: EndMode;
};

export type RunSnapshot = {
  runId: string;
  config: FrozenRunConfig;
  catalogVersion: string;
  engineVersion: string;
  submissionFingerprint?: string | null;
  dataContext?: RunDataContext | null;
  dataFingerprint?: string | null;
  dataProvenance?: RunDataProvenance;
  dateAdjustments?: Array<RunDateAdjustment>;
  createdAt?: string;
};

export type RunStrategySummary = {
  metrics?: MetricSummary | null;
  diagnostics?: Array<Diagnostic>;
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
  parameterValues: {
  [key: string]: unknown;
};
  reusedCalculation?: boolean;
  metrics?: MetricSummary | null;
  diagnostics?: Array<Diagnostic>;
  testResult?: SearchTestResult | null;
};

export type SearchDimension = {
  key: string;
  values: Array<unknown>;
  valuesParameterKey?: string | null;
  translationKey?: string;
};

export type SearchPeriod = {
  phase: "train" | "test";
  startDate: string;
  endDate: string;
  effectiveStartDate?: string | null;
  effectiveEndDate?: string | null;
};

export type SearchResult = {
  strategyId: string;
  dimensions: Array<SearchResultDimension>;
  totalCandidateCount: number;
  candidates: Array<SearchCandidate>;
  rankedCandidateIds: Array<string>;
  optimizationMode?: "full_period" | "train_test" | "walk_forward";
  trainPeriod?: SearchPeriod | null;
  testPeriod?: SearchPeriod | null;
  periodBenchmarks?: Array<StrategyRun>;
  walkForwardWindows?: Array<WalkForwardWindow>;
  outOfSample?: SearchTestResult | null;
  outOfSamplePeriod?: SearchPeriod | null;
};

export type SearchResultDimension = {
  key: string;
  values: Array<unknown>;
  translationKey?: string;
};

export type SearchTestResult = {
  resultId: string;
  status: StrategyStatus;
  metrics?: MetricSummary | null;
  diagnostics?: Array<Diagnostic>;
};

export type SharedSettings = {
  run: RunSettings;
  contribution: ContributionSettings;
  data: DataSettings;
  analysis?: AnalysisSettings | null;
  execution?: ExecutionSettings | null;
};

export type SignalEvaluation = {
  date: string;
  signalId: string;
  state: SignalState;
  observedValue?: string | null;
  observedUnit?: string | null;
  conditionId?: string | null;
  conditionKind?: ConditionKind | null;
  sourceSymbol?: string | null;
  sellRatio?: string | null;
  triggeredSignalIds?: Array<string>;
  diagnostics?: Array<Diagnostic>;
};

export type SignalState = "true" | "false" | "unavailable";

export type StrategyLimits = {
  maxInstancesPerPreset?: number;
  maxTotalInstances?: number;
};

export type StrategyPresetId = "vix_dca" | "composite_dca" | "ma_trend" | "ma_buy_only" | "monthly_dca" | "lump_sum" | "grid_search" | "rsi_dca" | "ma_deviation_dca" | "bollinger_dca" | "rate_dca";

export type StrategyRules = {
  buy?: ConditionLeaf | ConditionGroup | null;
  sell?: ConditionLeaf | ConditionGroup | null;
};

export type StrategyRun = {
  id: string;
  presetId: StrategyPresetId;
  instanceNumber?: number | null;
  role: ResultRole;
  status?: StrategyStatus;
  diagnostics?: Array<Diagnostic>;
  signals?: Array<SignalEvaluation>;
  technicalIndicators?: Array<TechnicalIndicatorSeries>;
  unexecutedSignals?: Array<UnexecutedSignal>;
  trades?: Array<Trade>;
  dailyAssets?: Array<DailyAsset>;
  metrics?: MetricSummary | null;
  searchResult?: SearchResult | null;
  evaluationPeriod?: SearchPeriod | null;
};

export type StrategyStatus = "queued" | "loading" | "running" | "completed" | "completed_with_warning" | "unavailable" | "failed" | "cancelled";

export type StrategyValidationResult = {
  strategyId: string;
  presetId: StrategyPresetId;
  enabled: boolean;
  normalized?: FrozenStrategyInstance | null;
  diagnostics?: Array<Diagnostic>;
};

export type SymbolSuggestion = {
  symbol: string;
  name: string;
  currency: string;
  source: string;
};

export type TechnicalIndicatorSample = {
  date: string;
  value?: string | null;
  lower?: string | null;
  upper?: string | null;
};

export type TechnicalIndicatorSeries = {
  kind: "ma" | "bollinger" | "rsi";
  period: number;
  deviations?: string | null;
  samples?: Array<TechnicalIndicatorSample>;
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
  cashBefore?: string | null;
  cashAfter?: string | null;
  quantityBefore?: string | null;
  quantityAfter?: string | null;
  executionBasePrice?: string | null;
  executionPrice?: string | null;
  grossAmount?: string | null;
  tradingCosts?: TradingCosts | null;
};

export type TradeReason = "fixed_dca" | "upfront" | "signal_buy" | "signal_sell" | "safety_valve";

export type TradeSide = "buy" | "sell";

export type TradingCosts = {
  commission: string;
  slippageCost: string;
  spreadCost: string;
  capitalGainsTax?: string | null;
  totalTradingCost: string;
};

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

export type WalkForwardWindow = {
  sequence: number;
  trainPeriod: SearchPeriod;
  testPeriod: SearchPeriod;
  candidateIds: Array<string>;
  rankedCandidateIds: Array<string>;
  selectedCandidateId?: string | null;
};
