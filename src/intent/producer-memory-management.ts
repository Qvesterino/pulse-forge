import { clearFavoriteLedger } from "./favorites";
import { clearPreferenceLedger, notifyProducerMemoryChanged, refreshPreferenceEventCache } from "./preference-ledger";
import { resetSemanticCorpusCache } from "./semantic";
import { clearStyleExamples } from "./style-example-ledger";
import { resetStyleVector } from "./style-vector";
import { deletePersonalModel, listPersonalModels } from "../persistence/PersonalModelRepository";
import { clearProducerMemory } from "../persistence/ProducerMemoryRepository";
import { clearProducerLineage } from "../persistence/ProducerLineageRepository";

/** Clear every local dataset or learned artifact that contributes to Producer DNA. */
export async function clearAllProducerMemory(): Promise<boolean> {
  const preferencesCleared = clearPreferenceLedger();
  const styleExamplesCleared = clearStyleExamples();
  const favoritesCleared = clearFavoriteLedger();
  const eventsCleared = await clearProducerMemory();
  if (eventsCleared) await refreshPreferenceEventCache();
  const lineageCleared = await clearProducerLineage();
  const personalModels = await listPersonalModels();
  const modelsCleared = await Promise.all(personalModels.map((model) => deletePersonalModel(model.base)));
  resetStyleVector();
  resetSemanticCorpusCache();
  notifyProducerMemoryChanged();
  return (
    preferencesCleared &&
    styleExamplesCleared &&
    favoritesCleared &&
    eventsCleared &&
    lineageCleared &&
    modelsCleared.every(Boolean)
  );
}
