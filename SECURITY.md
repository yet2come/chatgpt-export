# Security Policy

## 脆弱性の報告

本リポジトリで脆弱性を発見された場合は、公開 issue ではなく
GitHub の [Private Vulnerability Reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
を通じてご報告ください。

報告に含めていただきたい情報:

- 影響範囲（どの関数 / どの経路で発生するか）
- 再現手順
- 想定される影響（情報漏洩・任意ファイル書き込み・認証情報流出など）

## 対象範囲

本スクリプトは ChatGPT (chatgpt.com) のチャットページで DevTools コンソールから
実行される想定で、ユーザー認証セッションとローカルファイルシステムの両方にアクセスします。
特に次の経路が攻撃対象になり得ます。

- 会話 JSON / DOM 経由で attacker-controlled な値が流入する経路
- 認証トークンの取扱い
- ローカルファイル書き込み時のパス・拡張子推定
- credentialed cross-origin fetch

## サポート対象

最新の `main` ブランチのみをサポートします。過去バージョンへのバックポートは行いません。
