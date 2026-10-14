# Laboratory profiles

One JSON file per laboratory dialect. A profile says **where** to find a field
in an ORU^R01. It never says what a value means: result status comes from HL7
table 0085 and abnormal flags from table 0078, and a site that could redefine
"critical" would not be configuring an interface, it would be editing a
clinical safety control.

Loaded at boot from this directory (override with `NORTHSTAR_LABS`) and named by
a `labresults` destination:

```json
{
  "id": "lab-oru",
  "name": "Laboratory ORU into the order loop",
  "source": { "type": "mllp", "port": 6665 },
  "pipeline": [
    { "type": "filter.hl7Type", "allow": ["ORU^R01"] },
    { "type": "split.hl7Group", "segment": "OBR" }
  ],
  "destinations": [{ "id": "orders", "type": "labresults", "profile": "generic-oru", "ordered": true }]
}
```

A destination naming a profile that does not exist **fails the delivery**. It
does not fall back to the generic reading, because a site that configured a
vendor profile and silently got the generic one would believe it had a vendor
interface.

## Fields

| Field | Meaning |
|---|---|
| `id` | What a `labresults` destination names. Required. |
| `name` | Human label for operators. Required. |
| `patientAssigningAuthority` | The PID-3.4 whose identifier is the health number. A laboratory that also sends its own accession number in PID-3 is the ordinary case, and matching the wrong one finds nobody — or somebody else. |
| `patientIdentifierSystem` | The system the registration feed recorded that identifier under, so the index is searched the way it was written. |
| `placerOrderPaths` | Where the requisition number this clinic issued appears. First non-empty wins. |
| `fillerOrderPaths` | Where the laboratory's accession number appears. This is the deduplication key, so a laboratory that sends none cannot be deduplicated. |
| `timezoneOffset` | Applied to timestamps that carry no zone, e.g. `-05:00`. Declared, never guessed: a laboratory in one timezone reporting to a clinic in another is normal in Canada, and a result an hour out is a result on the wrong side of a shift change. A result whose time had no zone and no declared offset is filed with `timezone_assumed = 1` and counted in the reconciliation report. |
| `defaultCodeSystem` | Used when OBX-3.3 is empty. |

## What a profile cannot fix

**A laboratory that sends no accession number** cannot be deduplicated. Set
`fillerOrderPaths` to wherever it does put a specimen identity; if there is
genuinely none, every retransmission will be read as a correction, and that is
a conversation with the laboratory rather than a configuration option.

**A laboratory that sends no patient identifier** produces held results.
Nothing in a profile can invent one. See `GET /api/clinical/lab-held`.

## No vendor interfaces are shipped

There is no Dynacare profile here, and no LifeLabs profile. Writing one from a
published specification and calling it an interface would be the exact failure
this repository spends its time refusing: a component that reports itself
working while having never exchanged a message with the system it names.

A real vendor profile needs their conformance guide, a sandbox endpoint,
credentials, a connectivity certificate and a signed test result. Until those
exist, `generic-oru` is the honest configuration, and the reconciliation report
says what it had to assume.
