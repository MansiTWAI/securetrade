# Architecture
User/Vendor/Admin clients call the API. The API owns authorization and validation. Financial state is represented through wallets + ledger entries. P2P orders use an escrow record and explicit state transitions. Blockchain, market data, fiat payments and KYC/AML are external adapters and should be isolated behind provider interfaces.
