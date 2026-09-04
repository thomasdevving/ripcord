# Ripcord — complete video and live-demo scripts

Both scripts use Compound III's Ethereum USDC market:

```text
0xc3d688B66703497DAA19211EEdff47f25384cdc3
```

Text in quotation marks is meant to be read aloud. Directions in square
brackets are for the screen and are not spoken.

These scripts describe the committed `mobula-live-layer` hackathon scope. The
experimental AI selector work is deliberately not part of either demo or any
claim below.

## 1. Extended video script — approximately 11–13 minutes

This version is intentionally extensive. Record it in short sections and cut
pauses, loading time or complete modules afterwards. Use **Scan + withdrawal
test + drain proof** if you want to include the optional upgrade-proof section.

### 0:00–1:00 — The problem

[Show the Ripcord homepage and logo. Keep the product visible rather than using
a generic title slide.]

> “Hi, I'm Thomas, and this is Ripcord.
>
> DeFi security usually starts with the question: can an attacker break the
> code? Ripcord asks a different question: what can the people who are already
> authorised to control the protocol do?
>
> A protocol can be correctly coded and still give an administrator, guardian
> or governance system the power to change its rules or close an exit. For a
> depositor or risk team, that creates three practical questions.
>
> Who controls the protocol? How quickly can they act? And if something changes,
> can users leave first?
>
> Ripcord turns one contract address into an evidence-backed Exit Window. It
> reconstructs the control structure, measures the shortest enforced notice and,
> where the protocol is supported, executes a real withdrawal differential on a
> mainnet fork. If the evidence is incomplete, Ripcord says undetermined. It
> never converts unknown into safe.”

### 1:00–2:00 — Start the analysis

[Open **New analysis**. Select the Compound III preset. Choose **Scan +
withdrawal test + drain proof** and then **Ripcord + Mobula 2nd layer**.]

> “I will demonstrate this on Compound III's USDC market.
>
> Ripcord offers several levels of analysis. A scan reconstructs authority. The
> withdrawal mode also tests whether an authorised party can close a working
> exit. The drain-proof mode separately demonstrates what the upgrade authority
> could move through an implementation replacement.
>
> I am also explicitly enabling the experimental Mobula second layer. That
> choice matters: the standard Ripcord analysis sends nothing to Mobula. When I
> opt in, the analysed contract address is shared with Mobula only after the
> deterministic report has completed.
>
> I will start the analysis now. It takes longer than a normal webpage request
> because it performs contract discovery and multiple real fork experiments. I
> will cut to a completed run while explaining each stage.”

[Click **Analyze contract**. Show the run bar, selected layer, pinned block and
phase timeline. Cut to the completed run from the same target.]

### 2:00–2:45 — Pin one chain state

[Point to the pinned block number and report provenance.]

> “The first important step is reproducibility.
>
> Ripcord resolves one Ethereum block and pins both its number and its hash.
> Every later contract read is tied to that same state. The authority graph does
> not describe one block while the fork describes another, and a multi-minute
> analysis cannot silently drift with the chain tip.
>
> Ripcord also confirms that the supplied address contains contract bytecode at
> that block. A missing contract or an unavailable historical read becomes an
> explicit failure. It is never interpreted as an empty or permissionless
> system.”

### 2:45–4:25 — Reconstruct the power structure

[Show the **Power map** on the left. Select the target, implementation, proxy
admin, timelock and pause guardian so the evidence changes on the right.]

> “Ripcord now reconstructs who can actually control this contract.
>
> It reads known proxy storage slots to resolve the implementation and proxy
> admin. It recovers function selectors from bytecode and checks known ownership,
> AccessControl and protocol-specific authority handles. It also looks for
> sensitive capabilities such as upgrading or pausing.
>
> Finding a controller is not the end. A controller can itself be controlled by
> another contract. Ripcord therefore follows each discovered authority
> recursively until it reaches an externally owned account, a recognised Safe,
> a timelock, a cycle or an explicit search limit. If that traversal cannot be
> completed, the report keeps the gap visible.
>
> This map is the result for Compound. The market is a proxy, and its proxy admin
> can replace the implementation. Ripcord follows ownership of that admin and
> reaches Compound's governance timelock.
>
> But it does not copy a value labelled ‘two days’ and assume that users receive
> two days of protection. It checks whether the delay is binding on that route
> and whether a directly reachable shortening mechanism was found. For this
> upgrade route, the two-day delay is proven binding.
>
> Compound also exposes a separate pause guardian. That authority does not pass
> through the two-day upgrade timelock. The protocol therefore has more than one
> route capable of affecting users, and those routes have different notice.”

### 4:25–5:10 — Identify the user's exit

[Scroll toward the exit action and withdrawal experiment.]

> “Authority alone is not yet an Exit Window. Ripcord also needs to understand
> how a user leaves.
>
> For supported protocols it matches the contract against a registered interface
> fingerprint. This does not mean that Ripcord merely recognises the protocol's
> name. It means Ripcord has an explicit adapter that defines how to create a
> real position, which exit call to execute, which privileged mutation to test
> and which state changes prove that the exit actually worked.
>
> In this report, the recognised interface is Compound Comet, so Ripcord can test
> the USDC withdrawal path rather than guessing a generic function call.”

### 5:10–6:40 — Execute the fork differential

[Show **The withdrawal experiment**. Pause on baseline, privileged mutation and
same withdrawal again. Open transaction details briefly if they remain readable.]

> “The decisive test happens on a local Anvil mainnet fork pinned to the report's
> block.
>
> First, Ripcord creates the control branch. It funds an isolated sandbox holder,
> supplies USDC into Compound and checks the resulting position. It then executes
> a real withdrawal. The transaction succeeds, the position changes as expected
> and the holder recovers the supplied asset. That establishes that the exit was
> open before anything privileged happened.
>
> Ripcord takes and restores fork snapshots so the comparison starts from the
> same position. It also assigns mined block timestamps deterministically, so a
> revert and replay cannot cause two otherwise identical branches to drift in
> time.
>
> In the mutation branch, Ripcord impersonates the address identified as the
> pause guardian and calls Compound's real pause function. It reads all relevant
> pause flags before and after the transaction and only attributes the result to
> the withdrawal pause if that is the isolated change it observed.
>
> Finally, the same sandbox holder repeats the identical withdrawal from the
> matching starting state. This time the transaction reverts with Compound's own
> `Paused` error and the position remains unchanged.
>
> That before-and-after comparison is the core differential: a working exit
> before the authorised mutation, and the same exit closed afterwards.”

### 6:40–7:40 — Read the Exit Window

[Show **Fork experiment result**, **Notice before the rules can change** and the
zero-second verdict.]

> “This distinction is essential. Ripcord did not find a withdrawal that was
> already broken. It demonstrated that the withdrawal worked and that an
> authorised controller could then close it.
>
> The upgrade route gives users two days of enforced notice. The guardian route
> gives them zero. A slow route does not protect a faster one, so Ripcord takes
> the shortest relevant route.
>
> The effective Exit Window is therefore zero.
>
> This is not an accusation that Compound is malicious. Ripcord proves protocol
> capability, not intent. The guardian is impersonated only inside the sandbox
> fork. Ripcord does not obtain a private key, compromise the Safe or reproduce
> its complete signature, guard and module process. No mainnet transaction is
> sent.”

### Optional 7:40–8:25 — Upgrade drain proof

[Keep this section only if **Upgrade drain proof** and its measured figure are
visible in the recorded report. Otherwise cut the entire block.]

> “Ripcord also tests a different capability on a separate fork: the proxy
> upgrade path.
>
> It uses the resolved upgrade authority's real route to install a sandbox-only
> implementation and demonstrates what that authority could ultimately move.
> In this pinned report, at least 540 million dollars of measured assets were
> moved by the proof.
>
> Ripcord does not present that as an immediate action. This upgrade route remains
> protected by the proven two-day timelock. The zero-second Exit Window comes
> from the separate guardian route, not from the upgrade proof.”

### 7:40/8:25–11:20 — The new Mobula second layer

[Open **Assets & analysis coverage**. Start with **Combined with the per-asset
pass** at the top of that section, then point to the two timestamps, candidate
verification, supported fork scenarios, counts and one expanded asset row.]

> “The deterministic report has now finished. The Mobula second layer starts
> afterwards and produces a separate sidecar.
>
> The original Mobula integration added a timestamped holdings snapshot. That
> was useful context, but it did not test whether the discovered assets were
> really part of the protocol's exit surface. The new layer goes further.
>
> First, Ripcord uses every asset identity in the fresh holdings array Mobula
> returned. That is not a claim that Mobula has discovered every asset the
> address truly holds: the vendor request still applies its own spam and
> liquidity filters. It means Ripcord's candidate pass is not limited again by
> the twelve rows shown in this interface, the one-dollar display floor or
> whether the vendor could calculate a price. That matters because a new or
> unpriced collateral asset is exactly the kind of asset a value-ranked display
> could hide.
>
> Ripcord then independently filters and verifies those candidates. It considers
> up to sixty-four unique, same-chain, non-native addresses with a valid EVM
> address shape. Native assets, malformed addresses, duplicates, other chains
> and candidates beyond the cap are counted by reason rather than silently
> discarded. An address is not treated as an ERC20 until its code and
> `balanceOf` response have been checked.
>
> For each selected address, Ripcord reads the contract code and calls
> `balanceOf` against the analysed Compound market at the pinned report block.
> The vendor's symbol, balance and current valuation never become onchain facts.
> Even a verified zero balance may continue, because a registered collateral
> asset can be relevant without being held by the target at that exact moment.
>
> Next, Compound itself is asked whether the token is a registered collateral
> asset. A recognised asset enters the supported fork adapter. Ripcord creates
> an isolated holder, seeds only that sandbox holder with tokens inside Anvil,
> executes the token's real approval, supplies the position to Compound and
> proves that the collateral can be withdrawn.
>
> It then restores the candidate's own fork snapshot, calls the real guardian
> pause and repeats the identical collateral withdrawal. Each asset is isolated,
> so one candidate cannot contaminate the starting state of the next.
>
> Finally, a separate composer decides whether this evidence can be read beside
> the report. It requires the target address, chain, block number, block hash and
> fork block to match. If any identity differs, the sidecar is marked unusable
> for that report.
>
> A confirmed restriction may show that the main finding reaches more assets
> than the original USDC experiment established. It still does not rewrite the
> core verdict. A candidate that shows no effect proves only that one action did
> not close one exit in one experiment. Unsupported, failed and unresolved
> candidates remain visible and can never be turned into a safety claim.
>
> This gives Mobula a precise role. It expands discovery and supplies current
> market context. Ripcord independently verifies identities and produces the
> security evidence. These are deliberately two different clocks: Mobula's
> discovery describes its fresh response, while every security claim is tied to
> the historical block pinned in the report. The vendor never determines the
> verdict.”

### 11:20–12:35 — What comes next

[Show the roadmap slide or finish on the Ripcord report.]

> “The current second layer is deliberately labelled experimental. It supports
> one Compound III adapter, one collateral-withdrawal action and one guardian
> pause mutation. A confirmed restriction is meaningful evidence, but the
> absence of one is not complete protocol coverage.
>
> After the hackathon I want to expand the adapter model across lending markets,
> vaults and staking systems. I also want Ripcord to move from testing one
> privileged action to testing complete failure scenarios: governance proposals
> and timelock execution, oracle changes, liquidity shocks, mass withdrawals and
> combinations of actions that only become dangerous in sequence.
>
> Mobula can then continuously propose changes in asset exposure. Ripcord will
> verify those assets onchain, run the relevant protocol-specific scenarios and
> alert risk teams when authority, exit conditions or affected value changes.
>
> The final product is continuous sovereignty monitoring: not only whether the
> code contains a bug, but whether users still have time and a working path to
> leave.
>
> That is Ripcord.”

## 2. Live showcase script — approximately 5:30

For the live version, prepare three tabs: the deck, **New analysis** already
filled with the Compound address, and a completed live Compound report whose
Mobula sidecar has finished. Start a real analysis, but do not wait for it.

### Read-aloud script

[Show the opening slide.]

> “Hi, I'm Thomas, and this is Ripcord.
>
> DeFi security often asks whether an attacker can break the code. Ripcord asks
> a different question: **what can the authorised controllers do?**
>
> A protocol can be correctly coded and still allow a guardian to close
> withdrawals immediately. So before capital enters, risk teams need to know:
> who controls the protocol, how quickly can they act, and can users exit first?
>
> That is why I built Ripcord.
>
> Ripcord turns one contract address into an evidence-backed Exit Window. It
> reconstructs the control structure, measures the shortest enforced notice and,
> where supported, tests whether a working withdrawal can actually be closed on
> a mainnet fork.
>
> If the evidence is incomplete, Ripcord says **undetermined**. It never turns
> unknown into safe.”

[Open **New analysis**, select **Scan + withdrawal test**, select **Ripcord +
Mobula 2nd layer**, and click **Analyze contract**.]

> “Let me show you Compound III's USDC market.
>
> I am selecting the withdrawal test and explicitly opting in to the experimental
> Mobula second layer. That option is currently available only for this supported
> Compound adapter. I will start a real analysis now. While it runs, I will use a
> completed report for the same target to explain what happens inside the
> system.”

[Point briefly to **Core + Mobula 2nd layer**, the pinned block and live phase
timeline. Then switch immediately to the completed report.]

> “First, Ripcord resolves one Ethereum block and pins both its number and hash.
> Every subsequent read describes the same chain state.
>
> It confirms that the target contains contract code, reads known proxy storage
> slots and finds the implementation and proxy admin. It then searches for
> ownership, roles and sensitive powers such as pausing or upgrading.
>
> When it finds a controller, Ripcord follows that chain recursively until it
> reaches an EOA, Safe, timelock, cycle or explicit search limit.”

[Show the **Power map** and click the relevant nodes.]

> “This power map is the result.
>
> Compound is a proxy. Its proxy admin can replace the implementation. Ripcord
> follows control of that admin and reaches Compound's timelock.
>
> It does not simply read ‘two days’ and trust it. It checks whether the delay is
> binding on this route and whether a directly reachable shortening mechanism
> was found. Here, the two-day delay is proven binding.
>
> But there is another route. Compound has a separate pause guardian, and that
> authority does not pass through the two-day upgrade timelock.”

[Scroll to **The withdrawal experiment**.]

> “Ripcord recognises Compound's supported interface, so it knows how to create a
> position and how a user normally exits.
>
> On a pinned mainnet fork, Ripcord funds a sandbox account, supplies USDC and
> confirms that a withdrawal succeeds. That proves the exit is initially open.
>
> It then restores the same starting state. Inside the fork, it impersonates the
> authorised guardian and calls Compound's real pause function. The same account
> repeats the identical withdrawal under matched block and time conditions.
>
> This time, it reverts with Compound's own **Paused** error.”

[Show **Fork experiment result** and the route comparison.]

> “That distinction matters. The exit was not already closed. It was open, and
> Ripcord demonstrated that an authorised controller could close it without an
> enforced delay.
>
> The upgrade route gives users two days. The guardian route gives them zero.
> Ripcord takes the shortest relevant route.
>
> **So the effective Exit Window is zero.**
>
> This does not mean Compound is malicious or that its Safe was compromised. The
> guardian is impersonated only inside the local fork. No private key is used and
> no mainnet transaction is sent. Ripcord proves protocol capability, not
> malicious intent.”

[Open **Assets & analysis coverage** and show **Combined with the per-asset
pass** at the top of that section.]

> “After the deterministic report finishes, the new Mobula second layer begins.
> It is separate, optional and cannot change the report's verdict.
>
> Ripcord uses every asset identity in the fresh holdings array Mobula returned,
> not only the value-filtered top twelve shown in the interface. This does not
> claim that the vendor found every asset the address truly holds. Ripcord then
> selects up to sixty-four unique same-chain address candidates and checks their
> contract code and `balanceOf` response for the Compound market at the report's
> pinned block. Vendor symbols, balances and valuations remain unverified
> context.
>
> Ripcord asks Compound itself whether each token is registered collateral. A
> supported asset receives its own isolated fork experiment: create a sandbox
> position, prove the collateral withdrawal works, restore the snapshot, execute
> the real guardian pause and repeat the same withdrawal.
>
> Before that evidence is attached, the target, chain, block number, block hash
> and fork block must all match. A confirmed restriction can broaden the finding
> to additional assets. A failed, unsupported or no-effect candidate never makes
> the protocol look safer, and the core verdict remains unchanged.
>
> So Mobula expands what Ripcord can discover. Its snapshot is current vendor
> context; the security evidence remains pinned to the report's historical
> block. Ripcord still verifies what is real and proves what the authority can
> do.”

[Return to the roadmap/closing slides.]

> “After the hackathon, I want Ripcord to expand beyond one Compound adapter and
> test complete failure scenarios: governance execution, oracle changes,
> liquidity shocks, mass withdrawals and multi-step combinations.
>
> Mobula can continuously propose changes in asset exposure. Ripcord can verify
> those changes onchain and rerun the relevant exit tests.
>
> The final product is continuous sovereignty monitoring: when authority, exit
> conditions or affected assets change, Ripcord tells risk teams whether users
> still have time to leave.
>
> **Security asks whether someone can break in. Ripcord asks whether the people
> already inside can lock the exit.**
>
> Thank you.”

## Live failure fallbacks

- If the new analysis is slow: “The request is admitted and pinned. I am using
  the prepared report so we do not spend the showcase waiting for RPC work.”
- If Mobula is pending or unavailable: “The deterministic report completed. The
  optional vendor-backed layer failed separately, so it makes no claim and does
  not affect the verdict.”
- If the network fails entirely: return to slide 3 and press `B`, or play the
  recorded MP4.
- Never describe `no_effect`, `unresolved` or `unavailable` as safe.

## Recording checklist

- Record at 1920×1080 with browser zoom around 125–150%.
- Hide notifications, bookmarks, developer tools, API logs and `.env`.
- Record each numbered video section separately; leave two seconds of silence at
  both ends to make cutting easier.
- Show the pinned historical block at least once and do not call it live mainnet
  state.
- Only speak asset counts and dollar figures that are visible in the recorded
  report.
- Export an H.264 MP4 and test the final file offline from the USB drive.
