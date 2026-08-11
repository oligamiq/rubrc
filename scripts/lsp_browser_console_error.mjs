const OPTIONAL_METADATA_NOT_FOUND_TEXT =
  "Failed to load resource: the server responded with a status of 404 (Not Found)";

export function shouldSuppressOptionalMetadataNotFound(text, locationUrl) {
  if (
    text !== OPTIONAL_METADATA_NOT_FOUND_TEXT ||
    typeof locationUrl !== "string" ||
    locationUrl === ""
  ) {
    return false;
  }

  let location;
  try {
    location = new URL(locationUrl);
  } catch {
    return false;
  }
  return (
    (location.protocol === "http:" || location.protocol === "https:") &&
    location.pathname === "/.rubrc-pages-build.json" &&
    location.search === "" &&
    location.hash === ""
  );
}
