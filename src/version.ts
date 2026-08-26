/**
 * The engine version, reported in the FHIR CapabilityStatement.
 *
 * Declared here rather than read from package.json so it survives being run
 * from a directory that does not carry one, and so it is stated once rather
 * than repeated at each endpoint that reports it.
 */
export const VERSION = "0.7.0";
