const OPTIONAL_METADATA_NOT_FOUND_TEXT =
  "Failed to load resource: the server responded with a status of 404 (Not Found)";

export function shouldSuppressOptionalMetadataNotFound(
  text,
  locationUrl,
  expectedMetadataUrl,
) {
  if (
    text !== OPTIONAL_METADATA_NOT_FOUND_TEXT ||
    typeof locationUrl !== "string" ||
    locationUrl === "" ||
    typeof expectedMetadataUrl !== "string" ||
    expectedMetadataUrl === ""
  ) {
    return false;
  }

  try {
    return new URL(locationUrl).href === new URL(expectedMetadataUrl).href;
  } catch {
    return false;
  }
}
