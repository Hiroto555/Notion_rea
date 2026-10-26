# 構造調査の結論

Notion: REAによりapp.asarの配置を確認しElectron候補と推定。ネイティブAXではタブ用ローカルWeb領域と文書Web領域を観察。プロセス境界・IPC・保存方式の詳細はUNKNOWN。

Folio: Main → sandboxed preload → React/Tiptap renderer。データはMain管理のSQLite。REAの自作ビルド解析でbridgeとIPCの静的対応を確認し、実機テストでsandbox・contextIsolation・Node非公開を確認。

前者を後者の内部設計の証明として使わない。詳細は `EVIDENCE.md` と `../ARCHITECTURE.md`。
