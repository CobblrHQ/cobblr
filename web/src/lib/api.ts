// Re-exports only. The client lives in ./api/client.ts and every endpoint in
// its area file under ./api/, so two feature PRs in different areas touch no
// common file here (#7364, lint:api-client-by-area).
export { accountToken, getToken, sessionIdentity, setToken, SESSION_CHANGED, fetchAuthBlobUrl, fetchCsv, ApiError, subscribeConnectivity, subscribeOfflineCopies, OFFLINE_SENTENCE, pingHealth, subscribeWorkspaceShape, noteWorkspaceShape, subscribeWorkspaceWrite, subscribeAiAvailability, idsThatFitAUrl, subscribeDeletedRecord } from "./api/client";
export * from "./api/account";
export * from "./api/actions";
export * from "./api/activity";
export * from "./api/admin";
export * from "./api/ai";
export * from "./api/assets";
export * from "./api/auth";
export * from "./api/authoring";
export * from "./api/bundles";
export * from "./api/calendar";
export * from "./api/catalogs";
export * from "./api/devices";
export * from "./api/digifab";
export * from "./api/discussion";
export * from "./api/documents";
export * from "./api/entities";
export * from "./api/feedback";
export * from "./api/fields";
export * from "./api/files";
export * from "./api/import";
export * from "./api/integrations";
export * from "./api/inventory";
export * from "./api/labels";
export * from "./api/locations";
export * from "./api/machines";
export * from "./api/maintenance";
export * from "./api/members";
export * from "./api/notifications";
export * from "./api/people";
export * from "./api/placement";
export * from "./api/print";
export * from "./api/public-surfaces";
export * from "./api/purchases";
export * from "./api/records";
export * from "./api/scan";
export * from "./api/search";
export * from "./api/sharing";
export * from "./api/tags";
export * from "./api/templates";
export * from "./api/units";
export * from "./api/vault";
export * from "./api/views";
export * from "./api/workspace";

import { accountApi } from "./api/account";
import { actionsApi } from "./api/actions";
import { activityApi } from "./api/activity";
import { adminApi } from "./api/admin";
import { aiApi } from "./api/ai";
import { assetsApi } from "./api/assets";
import { authApi } from "./api/auth";
import { authoringApi } from "./api/authoring";
import { bundlesApi } from "./api/bundles";
import { calendarApi } from "./api/calendar";
import { catalogsApi } from "./api/catalogs";
import { devicesApi } from "./api/devices";
import { digifabApi } from "./api/digifab";
import { discussionApi } from "./api/discussion";
import { documentsApi } from "./api/documents";
import { entitiesApi } from "./api/entities";
import { feedbackApi } from "./api/feedback";
import { fieldsApi } from "./api/fields";
import { filesApi } from "./api/files";
import { importApi } from "./api/import";
import { integrationsApi } from "./api/integrations";
import { inventoryApi } from "./api/inventory";
import { labelsApi } from "./api/labels";
import { locationsApi } from "./api/locations";
import { machinesApi } from "./api/machines";
import { maintenanceApi } from "./api/maintenance";
import { membersApi } from "./api/members";
import { notificationsApi } from "./api/notifications";
import { peopleApi } from "./api/people";
import { placementApi } from "./api/placement";
import { printApi } from "./api/print";
import { publicSurfacesApi } from "./api/public-surfaces";
import { purchasesApi } from "./api/purchases";
import { recordsApi } from "./api/records";
import { scanApi } from "./api/scan";
import { searchApi } from "./api/search";
import { sharingApi } from "./api/sharing";
import { tagsApi } from "./api/tags";
import { templatesApi } from "./api/templates";
import { unitsApi } from "./api/units";
import { vaultApi } from "./api/vault";
import { viewsApi } from "./api/views";
import { workspaceApi } from "./api/workspace";

export const api = {
  ...accountApi,
  ...actionsApi,
  ...activityApi,
  ...adminApi,
  ...aiApi,
  ...assetsApi,
  ...authApi,
  ...authoringApi,
  ...bundlesApi,
  ...calendarApi,
  ...catalogsApi,
  ...devicesApi,
  ...digifabApi,
  ...discussionApi,
  ...documentsApi,
  ...entitiesApi,
  ...feedbackApi,
  ...fieldsApi,
  ...filesApi,
  ...importApi,
  ...integrationsApi,
  ...inventoryApi,
  ...labelsApi,
  ...locationsApi,
  ...machinesApi,
  ...maintenanceApi,
  ...membersApi,
  ...notificationsApi,
  ...peopleApi,
  ...placementApi,
  ...printApi,
  ...publicSurfacesApi,
  ...purchasesApi,
  ...recordsApi,
  ...scanApi,
  ...searchApi,
  ...sharingApi,
  ...tagsApi,
  ...templatesApi,
  ...unitsApi,
  ...vaultApi,
  ...viewsApi,
  ...workspaceApi,
};
