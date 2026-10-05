import type { DailyAsset, SignalEvaluation, TechnicalIndicatorSeries, Trade } from "../../../api/generated";
import type { Locale } from "../../../i18n/messages";
import type { SavedVolatilitySeries } from "../model";
import type { ChartSeriesId, SeriesSample, NormalizedSeries } from "../chartModel";

export type AxisSeriesId = ChartSeriesId | "rsi" | "index";

export interface StrategyChartSeries {
  id: string;
  label: string;
  color: string;
  dailyAssets: DailyAsset[];
  trades?: Trade[];
}

export interface NormalizedComparisonSeries extends StrategyChartSeries {
  result: NormalizedSeries;
}

export interface ResultsChartsProps {
  busy?: boolean;
  locale: Locale;
  dailyAssets: DailyAsset[];
  trades: Trade[];
  signals: SignalEvaluation[];
  comparisonSeries?: StrategyChartSeries[];
  strategyOrder?: string[];
  totalAssetColor?: string;
  totalAssetLabel?: string;
  totalAssetResultId?: string;
  volatilitySeries?: SavedVolatilitySeries[];
  technicalIndicators?: TechnicalIndicatorSeries[];
  showFocusedAsset?: boolean;
  vixSymbol?: string;
  vixThreshold?: string;
  visibleSeriesIds: string[];
  onSeriesChange(id: string, visible: boolean): void;
  onTradeSelect?(resultId: string, index: number): void;
  inspectedSeriesId?: string | null;
  onInspectedSeriesChange?(id: string | null): void;
}

export interface SeriesDefinition {
  id: ChartSeriesId;
  color: string;
  labelKey: string;
  label?: string;
  resultId?: string;
}

export interface IndicatorComparison { label: string; color: string; samples: SeriesSample[] }

export type IndicatorSeriesDefinition = Omit<SeriesDefinition, "id"> & { id: "drawdown" | "vix" | "rsi" };

export interface ChartPoint extends SeriesSample {
  x: number;
  y: number;
}

export interface ChartScale {
  minimum: number;
  maximum: number;
  y(value: number): number;
}
