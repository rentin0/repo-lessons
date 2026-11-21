# Repo Lessons

[English](README.md)

プロジェクトで得た教訓を Git に残し、Codex や Claude Code に依頼を送るときに関連する教訓を取り出すプラグインです。繰り返し起きたミス、テストの注意点、そのプロジェクト固有の約束事などを記録できます。

教訓は1件ずつ JSON ファイルに保存します。チームで PR をレビューしながら教訓を追加でき、別々の教訓は独立してマージできます。古い教訓の訂正も、元の記録を残したまま行えます。どちらのエージェントも、作業中の Git チェックアウトから教訓を読みます。

**状態**　初期リリースです。

## インストールする

Git、Node.js 24、Codex CLI または Claude Code が必要です。使うクライアントに対応するコマンドを実行します。

```sh
# Codex
codex plugin marketplace add https://github.com/rentin0/repo-lessons.git
codex plugin add repo-lessons@repo-lessons

# Claude Code
claude plugin marketplace add https://github.com/rentin0/repo-lessons.git
claude plugin install repo-lessons@repo-lessons
```

Codex では、確認画面または `/hooks` でプラグインの `UserPromptSubmit` フックを確認して承認します。プロジェクトに同等のフックがすでにある場合は、教訓が二重に追加されないよう片方を有効にします。

## Git リポジトリで試す

CLI を使うために Repo Lessons をクローンし、試したい Git リポジトリのルートへ移動します。

```sh
git clone https://github.com/rentin0/repo-lessons.git
lessons_marketplace="$(cd repo-lessons && pwd)"
cd /path/to/your/git-repository

node "$lessons_marketplace/plugins/repo-lessons/.agents/lessons/cli.ts" \
  add 'キャッシュキーを変更するときは、古いエントリの削除方法を記録する。' \
  --root "$PWD" --tag caching
```

生成された `.agents/lessons/records/` 内のファイルをコミットすると、チームで共有できます。そのリポジトリでクライアントを開き、「キャッシュキーを変更する前に何を確認すればいい？」のような関連する依頼を送ってみてください。

教訓を訂正する場合は、CLI の `search --json` で旧版の完全な ID を確認し、新しい教訓を追加するときに `--supersedes <ID>` を指定します。旧版は Git の履歴に残り、検索結果からは外れます。

## 仕組み

依頼を送ると、プラグインは作業中の Git チェックアウトのルートを見つけ、教訓を検索します。単語や文字の並びの近さから最大5件を選び、本文と出典パスを補足情報としてクライアントに渡します。

検索は手元で処理するため、外部の検索サービス、埋め込み API、vec1 のセットアップは不要です。選ばれた教訓はエージェントのコンテキストに入り、利用するモデルへのリクエストに含まれることがあります。

## ライセンス

[MIT](LICENSE)
