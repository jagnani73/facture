-- Point Harrow Point at the Arc wallet that exists.
--
-- Its `arc_address` was `0x77Ba0e4c…`, invented along with every other seeded buyer's. That is
-- survivable while nothing pays them and stops being survivable the moment a mandate is
-- registered on `MandateVault`: `executeRelease` returns capital to the address registered
-- against the mandate, so an invented one is a release nobody can receive.
--
-- `0x1c755e95…` is the Circle developer-controlled wallet the agent operates, and Harrow Point
-- is the seeded desk that is agent-operated — so it is the one buyer whose recorded address can
-- be made true without inventing a second fiction. The other four stay invented, and stay
-- unescrowed, which is the honest pairing: no capital is claimed on chain for them.
--
-- A plain UPDATE. No table rebuild, so unlike `0003` this applies through `pnpm db:migrate`
-- against a populated database.
UPDATE `buyers`
SET `arc_address` = '0x1c755e95cb11e5d5af498bb0ea595b56e1adb035'
WHERE `name` = 'Harrow Point';
