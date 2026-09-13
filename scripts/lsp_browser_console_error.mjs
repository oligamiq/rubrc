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

function describeInspectionError(error) {
  try {
    if (error instanceof Error) {
      return error.message === ""
        ? error.name
        : `${error.name}: ${error.message}`;
    }
    return String(error);
  } catch {
    return "Unknown";
  }
}

export async function inspectConsoleArguments(args) {
  return Promise.all(
    args.map(async (argument) => {
      try {
        return await argument.evaluate((value) =>
          value instanceof Error
            ? {
                name: value.name,
                message: value.message,
                stack: value.stack,
              }
            : String(value),
        );
      } catch (error) {
        return `uninspectable console argument: ${describeInspectionError(error)}`;
      }
    }),
  );
}
