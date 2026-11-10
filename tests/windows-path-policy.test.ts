import { describe, expect, it } from "vitest";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import {
  assertWindowsProbe,
  validateWindowsPath,
} from "../src/platform/windows/path-policy";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CollaborationError) return error.code;
    throw error;
  }
  throw new Error("expected a CollaborationError");
}

function validProbe(): Record<string, unknown> {
  return {
    platform: "win32",
    sid: "S-1-5-21-1004336348-1177238915-682003330-1001",
    ownerSid: "S-1-5-21-1004336348-1177238915-682003330-1001",
    daclPrivate: true,
    reparsePoint: false,
    linkCount: 1,
    fileId: "00000000000000000000000000000001",
    rootFileId: "00000000000000000000000000000002",
    rootVolumeId: "0000000000000001",
    canonicalPath: "C:\\Users\\Alice\\Folio\\doc.txt",
    canonicalRoot: "C:\\Users\\Alice\\Folio",
    volumeId: "0000000000000001",
    localFilesystem: true,
  };
}

describe("validateWindowsPath successful legal operations", () => {
  it("accepts a Japanese local path under a Japanese root", () => {
    const result = validateWindowsPath(
      "C:\\Users\\山田\\書類\\メモ.txt",
      "C:\\Users\\山田",
    );
    expect(result).toEqual({
      canonical: "C:\\Users\\山田\\書類\\メモ.txt",
      relative: "書類\\メモ.txt",
    });
  });

  it("normalizes the drive letter and forward separators", () => {
    const result = validateWindowsPath(
      "c:/Users/Alice/Documents/note.md",
      "C:\\Users\\Alice",
    );
    expect(result).toEqual({
      canonical: "C:\\Users\\Alice\\Documents\\note.md",
      relative: "Documents\\note.md",
    });
  });

  it("contains case-insensitively while preserving the path's segment casing", () => {
    const result = validateWindowsPath(
      "C:\\users\\ALICE\\Docs\\Plan.txt",
      "c:\\Users\\Alice",
    );
    expect(result).toEqual({
      canonical: "C:\\users\\ALICE\\Docs\\Plan.txt",
      relative: "Docs\\Plan.txt",
    });
  });

  it("tolerates one trailing separator on the root and on the path", () => {
    expect(
      validateWindowsPath("C:\\Users\\Alice\\a.txt\\", "C:\\Users\\Alice\\"),
    ).toEqual({
      canonical: "C:\\Users\\Alice\\a.txt",
      relative: "a.txt",
    });
  });

  it("allows the root itself with an empty relative path", () => {
    expect(validateWindowsPath("C:\\Users\\Alice", "C:\\Users\\Alice")).toEqual(
      {
        canonical: "C:\\Users\\Alice",
        relative: "",
      },
    );
  });

  it("accepts a drive-root destination", () => {
    expect(validateWindowsPath("C:\\export.csv", "C:\\")).toEqual({
      canonical: "C:\\export.csv",
      relative: "export.csv",
    });
  });

  it("accepts internal spaces and dots in a legal file name", () => {
    expect(
      validateWindowsPath(
        "C:\\Users\\Alice\\My Documents\\v1.2 notes.md",
        "C:\\Users\\Alice",
      ),
    ).toEqual({
      canonical: "C:\\Users\\Alice\\My Documents\\v1.2 notes.md",
      relative: "My Documents\\v1.2 notes.md",
    });
  });

  it("accepts names that merely contain reserved words as a prefix", () => {
    expect(
      validateWindowsPath("C:\\Users\\Alice\\CONSOLE.txt", "C:\\Users\\Alice")
        .relative,
    ).toBe("CONSOLE.txt");
    expect(
      validateWindowsPath("C:\\Users\\Alice\\com10.log", "C:\\Users\\Alice")
        .relative,
    ).toBe("com10.log");
  });
});

describe("validateWindowsPath adversarial containment and syntax", () => {
  it("rejects a root-prefix sibling with the same character prefix", () => {
    expect(
      codeOf(() =>
        validateWindowsPath("C:\\Users\\Alice2\\a.txt", "C:\\Users\\Alice"),
      ),
    ).toBe("OUTSIDE_ROOT");
  });

  it("rejects a path shorter than the root", () => {
    expect(
      codeOf(() =>
        validateWindowsPath("C:\\Users\\Alice", "C:\\Users\\Alice\\Docs"),
      ),
    ).toBe("OUTSIDE_ROOT");
  });

  it("rejects a different drive as an escape", () => {
    expect(
      codeOf(() =>
        validateWindowsPath("D:\\Users\\Alice\\a.txt", "C:\\Users\\Alice"),
      ),
    ).toBe("DRIVE_MISMATCH");
  });

  it("rejects an ADS stream", () => {
    expect(
      codeOf(() =>
        validateWindowsPath(
          "C:\\Users\\Alice\\notes.txt:secret",
          "C:\\Users\\Alice",
        ),
      ),
    ).toBe("ADS");
  });

  it("rejects UNC network paths", () => {
    expect(
      codeOf(() =>
        validateWindowsPath("\\\\server\\share\\a.txt", "C:\\Users\\Alice"),
      ),
    ).toBe("UNC_PATH");
    expect(
      codeOf(() =>
        validateWindowsPath("//server/share/a.txt", "C:\\Users\\Alice"),
      ),
    ).toBe("UNC_PATH");
  });

  it("rejects extended and device prefixes", () => {
    expect(
      codeOf(() =>
        validateWindowsPath(
          "\\\\?\\C:\\Users\\Alice\\a.txt",
          "C:\\Users\\Alice",
        ),
      ),
    ).toBe("DEVICE_PREFIX");
    expect(
      codeOf(() =>
        validateWindowsPath(
          "\\\\.\\C:\\Users\\Alice\\a.txt",
          "C:\\Users\\Alice",
        ),
      ),
    ).toBe("DEVICE_PREFIX");
    expect(
      codeOf(() =>
        validateWindowsPath("\\\\?\\UNC\\server\\share", "C:\\Users\\Alice"),
      ),
    ).toBe("DEVICE_PREFIX");
  });

  it("rejects reserved names including extensions and in the root", () => {
    expect(
      codeOf(() =>
        validateWindowsPath("C:\\Users\\Alice\\CON.txt", "C:\\Users\\Alice"),
      ),
    ).toBe("RESERVED_NAME");
    expect(
      codeOf(() =>
        validateWindowsPath("C:\\Users\\Alice\\nul", "C:\\Users\\Alice"),
      ),
    ).toBe("RESERVED_NAME");
    expect(
      codeOf(() =>
        validateWindowsPath("C:\\Users\\Alice\\com1.log", "C:\\Users\\Alice"),
      ),
    ).toBe("RESERVED_NAME");
    expect(
      codeOf(() =>
        validateWindowsPath(
          "C:\\Users\\Alice\\LPT9.tar.gz",
          "C:\\Users\\Alice",
        ),
      ),
    ).toBe("RESERVED_NAME");
    expect(codeOf(() => validateWindowsPath("C:\\CON\\a.txt", "C:\\"))).toBe(
      "RESERVED_NAME",
    );
  });

  it("rejects traversal and dot segments", () => {
    expect(
      codeOf(() =>
        validateWindowsPath(
          "C:\\Users\\Alice\\..\\Bob\\a.txt",
          "C:\\Users\\Alice",
        ),
      ),
    ).toBe("TRAVERSAL");
    expect(
      codeOf(() =>
        validateWindowsPath("C:\\Users\\Alice\\.\\a.txt", "C:\\Users\\Alice"),
      ),
    ).toBe("DOT_SEGMENT");
  });

  it("rejects 8.3 tilde aliases", () => {
    expect(
      codeOf(() =>
        validateWindowsPath(
          "C:\\Users\\Alice\\PROGRA~1\\a.txt",
          "C:\\Users\\Alice",
        ),
      ),
    ).toBe("SHORT_NAME_ALIAS");
  });

  it("rejects trailing dots and spaces in any segment", () => {
    expect(
      codeOf(() =>
        validateWindowsPath("C:\\Users\\Alice\\name ", "C:\\Users\\Alice"),
      ),
    ).toBe("TRAILING_DOT_OR_SPACE");
    expect(
      codeOf(() =>
        validateWindowsPath("C:\\Users\\Alice\\name.", "C:\\Users\\Alice"),
      ),
    ).toBe("TRAILING_DOT_OR_SPACE");
    expect(
      codeOf(() =>
        validateWindowsPath("C:\\Users\\Alice \\a.txt", "C:\\Users\\Alice"),
      ),
    ).toBe("TRAILING_DOT_OR_SPACE");
  });

  it("rejects NUL and control characters", () => {
    expect(
      codeOf(() =>
        validateWindowsPath("C:\\Users\\Alice\\a\u0000b", "C:\\Users\\Alice"),
      ),
    ).toBe("CONTROL_CHAR");
    expect(
      codeOf(() =>
        validateWindowsPath("C:\\Users\\Alice\\a\tb", "C:\\Users\\Alice"),
      ),
    ).toBe("CONTROL_CHAR");
    expect(
      codeOf(() =>
        validateWindowsPath("C:\\Users\\Alice\\a\u007fb", "C:\\Users\\Alice"),
      ),
    ).toBe("CONTROL_CHAR");
  });

  it("rejects illegal segment characters", () => {
    for (const segment of ["a<b", "a>b", "a|b", "a?b", "a*b", 'a"b']) {
      expect(
        codeOf(() =>
          validateWindowsPath(
            `C:\\Users\\Alice\\${segment}`,
            "C:\\Users\\Alice",
          ),
        ),
      ).toBe("ILLEGAL_CHAR");
    }
  });

  it("rejects relative and drive-relative paths", () => {
    expect(
      codeOf(() =>
        validateWindowsPath("Users\\Alice\\a.txt", "C:\\Users\\Alice"),
      ),
    ).toBe("NOT_ABSOLUTE");
    expect(
      codeOf(() =>
        validateWindowsPath("C:Users\\Alice\\a.txt", "C:\\Users\\Alice"),
      ),
    ).toBe("NOT_ABSOLUTE");
    expect(codeOf(() => validateWindowsPath("C:", "C:\\"))).toBe(
      "NOT_ABSOLUTE",
    );
  });

  it("rejects repeated separators", () => {
    expect(
      codeOf(() =>
        validateWindowsPath("C:\\\\Users\\Alice\\a.txt", "C:\\Users\\Alice"),
      ),
    ).toBe("REPEATED_SEPARATOR");
    expect(
      codeOf(() =>
        validateWindowsPath("C:\\Users\\\\Alice\\a.txt", "C:\\Users\\Alice"),
      ),
    ).toBe("REPEATED_SEPARATOR");
  });

  it("rejects empty and non-string inputs while keeping caller input untouched", () => {
    const path = "";
    expect(codeOf(() => validateWindowsPath(path, "C:\\"))).toBe("EMPTY_PATH");
    expect(path).toBe("");
    expect(codeOf(() => validateWindowsPath("C:\\a.txt", ""))).toBe(
      "EMPTY_ROOT",
    );
    expect(
      codeOf(() => validateWindowsPath(123 as unknown as string, "C:\\")),
    ).toBe("INVALID_PATH_TYPE");
    expect(
      codeOf(() => validateWindowsPath("C:\\a.txt", null as unknown as string)),
    ).toBe("INVALID_ROOT_TYPE");
  });

  it("rejects malformed Unicode rather than normalizing it", () => {
    expect(
      codeOf(() =>
        validateWindowsPath("C:\\Users\\Alice\\\uD800.txt", "C:\\Users\\Alice"),
      ),
    ).toBe("UNICODE");
  });
});

describe("assertWindowsProbe strict evidence validation", () => {
  it("accepts a complete local private single-link probe", () => {
    expect(() => assertWindowsProbe(validProbe())).not.toThrow();
  });

  it("accepts a null-prototype record", () => {
    expect(() =>
      assertWindowsProbe(Object.assign(Object.create(null), validProbe())),
    ).not.toThrow();
  });

  it("rejects non-object and array evidence", () => {
    expect(codeOf(() => assertWindowsProbe(null))).toBe("PROBE_INVALID");
    expect(codeOf(() => assertWindowsProbe("win32"))).toBe("PROBE_INVALID");
    expect(codeOf(() => assertWindowsProbe([]))).toBe("PROBE_INVALID");
    expect(codeOf(() => assertWindowsProbe(new Date()))).toBe("PROBE_INVALID");
  });

  it("rejects missing and extra fields", () => {
    const missing = validProbe();
    delete missing.fileId;
    expect(codeOf(() => assertWindowsProbe(missing))).toBe("PROBE_INVALID");
    expect(
      codeOf(() => assertWindowsProbe({ ...validProbe(), extra: true })),
    ).toBe("PROBE_INVALID");
  });

  it("rejects non-win32 evidence", () => {
    expect(
      codeOf(() => assertWindowsProbe({ ...validProbe(), platform: "darwin" })),
    ).toBe("PROBE_PLATFORM");
  });

  it("requires owner and SID to match and be non-empty", () => {
    expect(
      codeOf(() =>
        assertWindowsProbe({ ...validProbe(), ownerSid: "S-1-5-21-other" }),
      ),
    ).toBe("PROBE_OWNER");
    expect(
      codeOf(() =>
        assertWindowsProbe({ ...validProbe(), sid: "", ownerSid: "" }),
      ),
    ).toBe("PROBE_SID");
  });

  it("requires a private DACL, no reparse point and a single link", () => {
    expect(
      codeOf(() => assertWindowsProbe({ ...validProbe(), daclPrivate: false })),
    ).toBe("PROBE_DACL");
    expect(
      codeOf(() => assertWindowsProbe({ ...validProbe(), reparsePoint: true })),
    ).toBe("PROBE_REPARSE");
    expect(
      codeOf(() => assertWindowsProbe({ ...validProbe(), linkCount: 2 })),
    ).toBe("PROBE_LINK_COUNT");
    expect(
      codeOf(() => assertWindowsProbe({ ...validProbe(), linkCount: "1" })),
    ).toBe("PROBE_LINK_COUNT");
  });

  it("requires non-empty file and volume identifiers", () => {
    expect(
      codeOf(() => assertWindowsProbe({ ...validProbe(), fileId: "" })),
    ).toBe("PROBE_FILE_ID");
    expect(
      codeOf(() => assertWindowsProbe({ ...validProbe(), volumeId: "" })),
    ).toBe("PROBE_VOLUME_ID");
  });

  it("requires a local filesystem", () => {
    expect(
      codeOf(() =>
        assertWindowsProbe({ ...validProbe(), localFilesystem: false }),
      ),
    ).toBe("PROBE_LOCAL_FS");
  });

  it("rejects accessors, symbols and non-enumerable replacements", () => {
    const accessor = validProbe();
    Object.defineProperty(accessor, "sid", {
      enumerable: true,
      get: () => accessor.ownerSid,
    });
    expect(codeOf(() => assertWindowsProbe(accessor))).toBe("PROBE_ACCESSOR");

    const symbol = validProbe();
    Object.defineProperty(symbol, Symbol("extra"), {
      value: true,
      enumerable: true,
    });
    expect(codeOf(() => assertWindowsProbe(symbol))).toBe("PROBE_INVALID");

    const hidden = validProbe();
    Object.defineProperty(hidden, "fileId", { value: "x", enumerable: false });
    expect(codeOf(() => assertWindowsProbe(hidden))).toBe("PROBE_INVALID");
  });
});
