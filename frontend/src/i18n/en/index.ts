import { commonMessages } from "./common";
import { strategiesMessages } from "./strategies";
import { resultsMessages } from "./results";
import { diagnosticsMessages } from "./diagnostics";

export const enMessages: Record<string, string> = {
  ...commonMessages,
  ...strategiesMessages,
  ...resultsMessages,
  ...diagnosticsMessages,
};
