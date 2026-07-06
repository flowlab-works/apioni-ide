# Homebrew Cask for Apioni IDE.
# Lives in a SEPARATE tap repo: flowlab-works/homebrew-apioni → Casks/apioni.rb
# Then users run:  brew install --cask flowlab-works/apioni/apioni
# (Submit to the official homebrew-cask later, once the app clears notability.)
#
# Update `version` and `sha256` on each release. Get the sha with:
#   shasum -a 256 "Apioni IDE_<version>_universal.dmg"
cask "apioni" do
  version "0.1.0"
  sha256 "REPLACE_WITH_DMG_SHA256"

  url "https://github.com/flowlab-works/apioni-ide/releases/download/desktop-v#{version}/Apioni.IDE_#{version}_universal.dmg",
      verified: "github.com/flowlab-works/apioni-ide/"
  name "Apioni IDE"
  desc "Terminal-first agentic IDE that supervises your Claude Code/Codex"
  homepage "https://ide.apioni.com/"

  depends_on macos: ">= :big_sur"

  app "Apioni IDE.app"

  zap trash: [
    "~/Library/Application Support/com.apioni.ide",
    "~/Library/Caches/com.apioni.ide",
    "~/Library/Preferences/com.apioni.ide.plist",
    "~/Library/Saved Application State/com.apioni.ide.savedState",
  ]
end
