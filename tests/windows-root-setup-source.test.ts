import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { wellFormed } from "../src/collaboration/runtime/contract";
import { validateWindowsPath } from "../src/platform/windows/path-policy";

const script = readFileSync(
  new URL(
    "../scripts/platform/windows/create-candidate-root.ps1",
    import.meta.url,
  ),
  "utf8",
);

function extractCsharp(source: string): string {
  const marker = "Add-Type -Language CSharp -TypeDefinition @'\n";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("CSHARP_BLOCK_MISSING");
  const bodyStart = start + marker.length;
  const end = source.indexOf("\n'@", bodyStart);
  if (end < 0) throw new Error("CSHARP_BLOCK_UNTERMINATED");
  return source.slice(bodyStart, end);
}

const csharp = extractCsharp(script);

function methodBody(name: string, nextName: string): string {
  const start = csharp.indexOf(name);
  const end = csharp.indexOf(nextName, start + name.length);
  if (start < 0 || end < 0) throw new Error(`METHOD_SLICE_${name}`);
  return csharp.slice(start, end);
}

function nonceAccepted(value: unknown): boolean {
  if (typeof value !== "string" || !wellFormed(value)) return false;
  if (value.length < 1 || value.length > 128) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  return true;
}

describe("windows candidate root source contract", () => {
  it("extracts one bounded C# block behind mandatory Root and Nonce parameters", () => {
    expect(csharp.length).toBeGreaterThan(20_000);
    expect(script).toContain("[Parameter(Mandatory = $true)]");
    expect(script).toContain("[string]$Root");
    expect(script).toContain("[string]$Nonce");
    expect(
      script.match(/Add-Type -Language CSharp -TypeDefinition @'/g),
    ).toHaveLength(1);
    expect(script).toContain(
      "[FolioWindowsCandidateRoot]::Run($Root, $Nonce, $sid)",
    );
  });

  it("creates the root and every known child with CreateDirectoryW and an atomic private descriptor", () => {
    expect(csharp).toContain("CreateDirectoryW");
    expect(csharp).toContain("SECURITY_ATTRIBUTES");
    expect(csharp).toContain(
      "attributes.lpSecurityDescriptor = descriptor.Pointer",
    );
    expect(csharp).toContain("ref attributes");
    expect(csharp).toContain("InitializeSecurityDescriptor");
    expect(csharp).toContain("SetSecurityDescriptorOwner");
    expect(csharp).toContain("SetSecurityDescriptorDacl");
    expect(csharp).toContain("SetSecurityDescriptorControl");
    expect(csharp).toContain("SE_DACL_PROTECTED");
    expect(csharp).toContain("AddAccessAllowedAceEx");
    expect(csharp).toContain("FILE_ALL_ACCESS");
    expect(csharp).toContain("SYSTEM_SID");
    expect(csharp.match(/CreateDirectoryW\(/g)).toHaveLength(2);
  });

  it("never creates or mutates directories through PowerShell cmdlets, ACL tools or deletion APIs", () => {
    const forbidden = [
      /\bNew-Item\b/i,
      /\bSet-Acl\b/i,
      /\bGet-Acl\b/i,
      /\bicacls\b/i,
      /\btakeown\b/i,
      /\bcacls\b/i,
      /\bRemove-Item\b/i,
      /\bClear-Content\b/i,
      /\bMove-Item\b/i,
      /\bRename-Item\b/i,
      /\bCopy-Item\b/i,
      /\bStart-Process\b/i,
      /\bInvoke-Expression\b/i,
      /\bSet-ExecutionPolicy\b/i,
      /\breg(?:\.exe)?\s+add\b/i,
      /\bschtasks\b/i,
      /\bcmd\.exe\b/i,
      /\bpowershell(?:\.exe)?\b/i,
      /Directory\.Delete/,
      /File\.Delete/,
      /RemoveDirectoryW/,
      /DeleteFileW/,
    ];
    for (const pattern of forbidden) {
      expect(script, pattern.source).not.toMatch(pattern);
    }
  });

  it("checks absence, parent trust, creation, validation and nonce writes in order", () => {
    const run = csharp.slice(
      csharp.indexOf("public static FolioWindowsCandidateResult Run("),
    );
    const order = [
      "ValidateNonce",
      "NormalizeStrict",
      "EnsureTargetAbsent",
      "ValidateParent",
      "CreateOwnedRoot",
      "CreateChildDirectories",
      "ValidateOwnedTree",
      "WriteOwnershipNonce",
      "ValidateOwnershipNonce",
      "Success",
    ].map((token) => {
      const index = run.indexOf(token);
      expect(index, token).toBeGreaterThanOrEqual(0);
      return index;
    });
    for (let index = 1; index < order.length; index++) {
      expect(order[index], `order ${index}`).toBeGreaterThan(order[index - 1]);
    }
  });

  it("rejects the shared Windows path-policy adversarial classes before creating anything", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["\\\\server\\share\\candidate", 'StartsWith("\\\\\\\\"'],
      ["\\\\?\\C:\\folio\\candidate", '@"\\??\\"'],
      ["C:\\folio\\..\\escape", 'segment == ".."'],
      ["C:\\folio\\.\\candidate", 'segment == "."'],
      ["C:\\folio\\candidate:stream", "item == ':'"],
      ["C:\\folio\\PROGRA~1", "segment[index] == '~'"],
      ["C:\\folio\\CON", 'names.Add("CON")'],
      ["C:\\folio\\bad*name", "item == '*'"],
      ["C:\\folio\\trailing.", "last == '.'"],
      ["C:\\\\folio", "if (rest[0] == '\\\\')"],
      ["C:\\folio\\\\child", "segment.Length == 0"],
      ["C:folio\\candidate", "input[2] != '\\\\'"],
      ["C:\\folio\\a\u0001b", "item < 0x20"],
      ["C:\\folio\\\ud800", "item >= 0xd800"],
    ];
    for (const [path, marker] of cases) {
      expect(() => validateWindowsPath(path, "C:\\"), path).toThrow();
      expect(csharp, path).toContain(marker);
    }
  });

  it("accepts ordinary legal candidate paths through the same shared policy", () => {
    const legal = [
      "C:\\Folio\\private-candidate",
      "C:\\Folio\\clienta",
      "C:\\Folio\\clientb",
      "C:\\Folio\\server",
      "D:\\Folio\\candidate-2026",
    ];
    for (const path of legal) {
      const drive = `${path[0].toUpperCase()}:\\`;
      expect(validateWindowsPath(path, drive).canonical, path).toBe(path);
      expect(csharp).toContain("if (!allowDriveRoot)");
      expect(csharp).toContain("MAX_SEGMENT_LENGTH");
    }
  });

  it("bounds nonce input to identifiers and 1..128 characters", () => {
    expect(nonceAccepted("A")).toBe(true);
    expect(nonceAccepted("a".repeat(128))).toBe(true);
    expect(nonceAccepted("abc_DEF-123.~")).toBe(false);
    expect(nonceAccepted("")).toBe(false);
    expect(nonceAccepted("a".repeat(129))).toBe(false);
    expect(nonceAccepted("a b")).toBe(false);
    expect(nonceAccepted("a\tb")).toBe(false);
    expect(nonceAccepted("caf\u00e9")).toBe(false);
    expect(nonceAccepted("a\u0000b")).toBe(false);
    expect(nonceAccepted("\u007f")).toBe(false);
    expect(nonceAccepted("\ud800")).toBe(false);
    expect(csharp).toContain("value.Length < 1 || value.Length > 128");
    expect(csharp).toContain("item>='A'&&item<='Z'");
    expect(csharp).toContain("item=='_'||item=='-'");
  });

  it("uses exactly the three known child names and ownership.nonce", () => {
    const names = /string\[\] names = new string\[\] \{([^}]*)\}/.exec(csharp);
    expect(names).not.toBeNull();
    const extracted = [...(names?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(extracted).toEqual(["clienta", "clientb", "server"]);
    expect(csharp).toContain('rootPath + "\\\\ownership.nonce"');
    expect(csharp).toContain('rootPath + "\\\\" + names[index]');
  });

  it("writes the nonce with CREATE_NEW and flushes the file handle without a directory-durability claim", () => {
    const writer = methodBody(
      "private static string WriteOwnershipNonce(",
      "private static void ValidateOwnershipNonce(",
    );
    expect(writer).toContain("CreateFileWithSecurityW");
    expect(writer).toContain("ref attributes");
    const create = writer.indexOf("CREATE_NEW");
    const write = writer.indexOf("WriteFile");
    const flush = writer.indexOf("FlushFileBuffers");
    expect(create).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(create);
    expect(flush).toBeGreaterThan(write);
    expect(csharp.match(/FlushFileBuffers\(/g)).toHaveLength(2);
    expect(csharp).not.toMatch(/FlushFileBuffers\([^)]*root/i);
    expect(csharp).not.toContain("directory durability");
  });

  it("validates actual file IDs, volume, owner and private DACL after creation", () => {
    expect(csharp).toContain("FileIdInfo");
    expect(csharp).toContain("GetFinalPathNameByHandleW");
    expect(csharp).toContain("GetVolumeInformationByHandleW");
    expect(csharp).toContain('"NTFS"');
    expect(csharp).toContain("FILE_REMOTE_DEVICE");
    expect(csharp).toContain("GetSecurityDescriptorControl");
    expect(csharp).toContain("GetAce");
    expect(csharp).toContain("GetLengthSid");
    expect(csharp).toContain("RejectReparseAncestors");
    expect(csharp).toContain("ValidatePrivateDacl");
    expect(csharp).toContain("FILE_FLAG_OPEN_REPARSE_POINT");
    expect(csharp).not.toContain("GetDriveTypeW");
  });

  it("checks parent owner and dangerous broad rights before creating the root", () => {
    const parent = methodBody(
      "private static void ValidateParent(",
      "private static void CreatePrivateDirectory(",
    );
    expect(parent).toContain("ValidateParentDacl");
    expect(parent).toContain(
      "InspectDirectory(handle, parentPath, currentSid, false, true)",
    );
    expect(csharp).toContain("IsTrustedOwner");
    expect(csharp).toContain("DANGEROUS_MASK");
    expect(csharp).toContain("ADMIN_SID");
    expect(csharp).toContain('drive + "\\\\Users\\\\Public"');
    expect(csharp).toContain("Environment.SpecialFolder.UserProfile");
    expect(csharp).toContain("WINDOWS_CANDIDATE_ROOT_TRUST");
    expect(csharp).toContain("WINDOWS_CANDIDATE_ROOT_PARENT");
  });

  it("retains partial roots and reports fixed failure fields without cleanup", () => {
    expect(csharp).toContain("ref bool created");
    expect(csharp).toContain("created = true");
    expect(csharp).toContain(
      "return Failure(failure.Code, created, rootPath, nonce, currentSid)",
    );
    expect(csharp).toContain(
      'Failure("WINDOWS_CANDIDATE_ROOT_FAILED", created, rootPath, nonce, currentSid)',
    );
    const failure = methodBody(
      "private static FolioWindowsCandidateResult Failure(",
      "public static FolioWindowsCandidateResult Run(",
    );
    expect(failure).toContain("result.candidate = false");
    expect(failure).toContain("result.created = created");
    expect(failure).toContain("result.nonce = nonce");
    expect(failure).toContain('result.ownershipPath = ""');
    expect(script).toContain("candidate       = $false");
    expect(script).toContain("physical        = 'NOT_RUN'");
  });

  it("reports success as a candidate with paths and file IDs while physical proof stays NOT_RUN", () => {
    const success = methodBody(
      "private static FolioWindowsCandidateResult Success(",
      "private static FolioWindowsCandidateResult Failure(",
    );
    expect(success).toContain("result.candidate = true");
    expect(success).toContain("result.created = true");
    expect(success).toContain('result.code = "WINDOWS_CANDIDATE_ROOT_READY"');
    expect(success).toContain("result.rootFileId = HexId(rootId)");
    expect(success).toContain("result.ownershipFileId = ownershipFileId");
    expect(success).toContain("result.directories = entries");
    expect(script).toContain("candidate       = [bool]$Result.candidate");
    expect(script).toContain("rootFileId      = [string]$Result.rootFileId");
    expect(script).toContain("directories     = $directories");
    expect(script.match(/physical        = 'NOT_RUN'/g)).toHaveLength(2);
    expect(script).not.toContain("physical        = 'VERIFIED'");
  });
});
