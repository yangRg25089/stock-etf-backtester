import { compareDecimals } from "../../api/contractReader";
import type { DrawdownEpisode, PerformanceAnalysis } from "../../api/generated";

export const MINIMUM_VISIBLE_DRAWDOWN = "-0.025";
export function visibleDrawdownEpisodes(episodes: DrawdownEpisode[]): DrawdownEpisode[] {
  return episodes.filter(episode => compareDecimals(episode.drawdown, MINIMUM_VISIBLE_DRAWDOWN) <= 0);
}
export function durationEpisode(analysis: PerformanceAnalysis, key: "maximumDrawdownDuration" | "recoveryDuration"): DrawdownEpisode | undefined {
  const episodes = analysis.drawdownEpisodes ?? [];
  const target = key === "maximumDrawdownDuration"
    ? episodes.find(episode => episode.durationDays === analysis.maximumDrawdownDuration)
    : [...episodes].sort((a, b) => compareDecimals(a.drawdown, b.drawdown))[0];
  return target && visibleDrawdownEpisodes([target]).length ? target : undefined;
}
export interface DrawdownLocation { peakDate: string; sequence: number }
