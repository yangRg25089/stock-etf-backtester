export function strategyInstanceName(name: string, instanceNumber?: number | null): string {
  return instanceNumber !== undefined && instanceNumber !== null && instanceNumber > 1
    ? `${name}${instanceNumber}`
    : name;
}
