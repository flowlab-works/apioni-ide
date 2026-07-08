# Homebrew Cask for Apioni IDE.
# Lives in a SEPARATE tap repo: flowlab-works/homebrew-apioni → Casks/apioni.rb
# Then users run:  brew install --cask flowlab-works/apioni/apioni
# (Submit to the official homebrew-cask later, once the app clears notability.)
#
# Update `version` and `sha256` on each release. Get the sha with:
#   shasum -a 256 "Apioni IDE_<version>_universal.dmg"
cask "apioni" do
  version "0.1.1"
  sha256 "ac3a7353ea366ce1c1a181d066909b6b022643639673408a2b546422a62368ae"

  url "https://github.com/flowlab-works/apioni-ide/releases/download/desktop-v#{version}/Apioni.IDE_#{version}_universal.dmg",
      verified: "github.com/flowlab-works/apioni-ide/"
  name "Apioni IDE"
  desc "Lightweight terminal for running AI CLIs"
  homepage "https://apioni.com/ide"

  depends_on macos: ">= :big_sur"

  app "Apioni IDE.app"

  zap trash: [
    "~/Library/Application Support/com.apioni.ide",
    "~/Library/Caches/com.apioni.ide",
    "~/Library/Preferences/com.apioni.ide.plist",
    "~/Library/Saved Application State/com.apioni.ide.savedState",
  ]
end
