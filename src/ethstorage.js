const fs = require("fs");
const {ethers} = require("ethers");
const {BlobUploader} = require("./uploader");
const {EncodeBlobs, BLOB_FILE_SIZE} = require("./blobs");

const MAX_BLOB_COUNT = 3;
const ETH_STORAGE = "0xb4B46bdAA835F8E4b4d8e208B6559cD267851051";
const flatDirectoryBlobAbi = [
    "constructor(uint8 slotLimit, uint32 size, address storageAddress) public",
    "function setDefault(bytes memory _defaultFile) public",
    "function upfrontPayment() external view returns (uint256)",
    "function getChunkHash(bytes memory name, uint256 chunkId) public view returns (bytes32)",
    "function writeChunks(bytes memory name, uint256[] memory chunkIds, uint256[] memory sizes) external payable",
];

const stringToHex = (s) => ethers.hexlify(ethers.toUtf8Bytes(s));

class EthStorage {
    #wallet;
    #blobUploader;
    #contractAddr;

    constructor(rpc, privateKey, contractAddr = null) {
        const provider = new ethers.JsonRpcProvider(rpc);
        this.#wallet = new ethers.Wallet(privateKey, provider);
        this.#blobUploader = new BlobUploader(rpc, privateKey);
        this.#contractAddr = contractAddr;
    }

    async deployDirectory() {
        const contractByteCode = '0x60e0604052600060c09081526006906200001a908262000191565b503480156200002857600080fd5b5060405162003996380380620039968339810160408190526200004b916200025d565b60ff8316608052828282818162000062336200009a565b63ffffffff9190911660a052600380546001600160a01b0319166001600160a01b0390921691909117905550620002c9945050505050565b600280546001600160a01b038381166001600160a01b0319831681179093556040519116919082907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e090600090a35050565b634e487b7160e01b600052604160045260246000fd5b600181811c908216806200011757607f821691505b6020821081036200013857634e487b7160e01b600052602260045260246000fd5b50919050565b601f8211156200018c57600081815260208120601f850160051c81016020861015620001675750805b601f850160051c820191505b81811015620001885782815560010162000173565b5050505b505050565b81516001600160401b03811115620001ad57620001ad620000ec565b620001c581620001be845462000102565b846200013e565b602080601f831160018114620001fd5760008415620001e45750858301515b600019600386901b1c1916600185901b17855562000188565b600085815260208120601f198616915b828110156200022e578886015182559484019460019091019084016200020d565b50858210156200024d5787850151600019600388901b60f8161c191681555b5050505050600190811b01905550565b6000806000606084860312156200027357600080fd5b835160ff811681146200028557600080fd5b602085015190935063ffffffff81168114620002a057600080fd5b60408501519092506001600160a01b0381168114620002be57600080fd5b809150509250925092565b60805160a051613699620002fd6000396000818161076c0152611abe01526000818161052b01526116f601526136996000f3fe608060405260043610620001ee5760003560e01c80635ba1d9e5116200010f578063a9950abf11620000a3578063e72438b0116200006d578063e72438b01462000758578063f14c7ad714620007a4578063f2fde38b14620007c6578063f916c5b014620007eb57620001ee565b8063a9950abf14620006b5578063caf1283614620006da578063d84eb56c1462000715578063dd473fae146200073a57620001ee565b806377ccbd9f11620000e557806377ccbd9f14620006265780638bf4515c146200064b5780638da5cb5b1462000670578063956a3433146200069057620001ee565b80635ba1d9e5146200059e578063715018a614620005c357806372e14dd714620005db57620001ee565b80631fbfa1271162000187578063492c7b2a116200015d578063492c7b2a14620005045780634eed7cf1146200051b57806358edef4c1462000561578063590e1ae3146200058657620001ee565b80631fbfa12714620004b05780632b68b9c614620004c757806342216bed14620004df57620001ee565b80631a7237e011620001c95780631a7237e014620003f45780631c5ee10c14620004295780631c993ad514620004645780631ccbc6da146200048957620001ee565b8063038cd79f146200037057806309362861146200038957806311ce026714620003b9575b348015620001fb57600080fd5b506000366060808284036200022157505060408051602081019091526000815262000365565b8383600081811062000237576200023762002a96565b9050013560f81c60f81b6001600160f81b031916602f60f81b146200028357505060408051808201909152600e81526d0d2dcc6dee4e4cac6e840e0c2e8d60931b602082015262000365565b83836200029260018262002ac2565b818110620002a457620002a462002a96565b909101356001600160f81b031916602f60f81b0390506200030657620002fd620002d2846001818862002ad8565b6006604051602001620002e89392919062002b3a565b60405160208183030381529060405262000810565b50905062000358565b6200035462000319846001818862002ad8565b8080601f0160208091040260200160405190810160405280939291908181526020018383808284376000920191909152506200081092505050565b5090505b62000363816200087f565b505b915050805190602001f35b620003876200038136600462002cda565b620008c0565b005b3480156200039657600080fd5b50620003a16200099e565b604051620003b0919062002d9d565b60405180910390f35b348015620003c657600080fd5b50600354620003db906001600160a01b031681565b6040516001600160a01b039091168152602001620003b0565b3480156200040157600080fd5b50620004196200041336600462002db2565b62000a34565b604051620003b092919062002dfa565b3480156200043657600080fd5b506200044e6200044836600462002e20565b62000ab2565b60408051928352602083019190915201620003b0565b3480156200047157600080fd5b50620003876200048336600462002e20565b62000b17565b3480156200049657600080fd5b50620004a162000b56565b604051908152602001620003b0565b62000387620004c136600462002ee8565b62000bcc565b348015620004d457600080fd5b506200038762000cb4565b348015620004ec57600080fd5b50620004a1620004fe36600462002db2565b62000cef565b620003876200051536600462002f79565b62000d6b565b3480156200052857600080fd5b507f000000000000000000000000000000000000000000000000000000000000000060ff1615155b6040519015158152602001620003b0565b3480156200056e57600080fd5b50620004a16200058036600462002e20565b62000e5c565b3480156200059357600080fd5b506200038762000ef2565b348015620005ab57600080fd5b5062000550620005bd36600462002db2565b62000f5c565b348015620005d057600080fd5b506200038762000ff7565b348015620005e857600080fd5b5062000617620005fa36600462002e20565b805160209182012060009081526005909152604090205460ff1690565b604051620003b0919062003005565b3480156200063357600080fd5b50620003876200064536600462003022565b62001032565b3480156200065857600080fd5b50620004196200066a36600462002e20565b62000810565b3480156200067d57600080fd5b506002546001600160a01b0316620003db565b3480156200069d57600080fd5b50620004a1620006af3660046200307c565b62001074565b348015620006c257600080fd5b5062000387620006d43660046200309f565b6200114c565b348015620006e757600080fd5b50620006ff620006f936600462002db2565b6200119b565b60408051928352901515602083015201620003b0565b3480156200072257600080fd5b50620004a16200073436600462002db2565b62001202565b3480156200074757600080fd5b50651b585b9d585b60d21b620004a1565b3480156200076557600080fd5b506200078e7f000000000000000000000000000000000000000000000000000000000000000081565b60405163ffffffff9091168152602001620003b0565b348015620007b157600080fd5b506003546001600160a01b0316151562000550565b348015620007d357600080fd5b5062000387620007e53660046200309f565b62001296565b348015620007f857600080fd5b50620004a16200080a36600462002e20565b62001335565b6060600060026200083884805160209182012060009081526005909152604090205460ff1690565b60028111156200084c576200084c62002fef565b036200086d57620008648380519060200120620013a5565b91509150915091565b620008648380519060200120620015b9565b600081516040620008919190620030ca565b9050601f19620008a3826020620030ca565b620008b090601f620030ca565b1690506020808303528060208303f35b6002546001600160a01b03163314620008f65760405162461bcd60e51b8152600401620008ed90620030e0565b60405180910390fd5b60006200091a84805160209182012060009081526005909152604090205460ff1690565b9050600081600281111562000933576200093362002fef565b1480620009545750600181600281111562000952576200095262002fef565b145b620009735760405162461bcd60e51b8152600401620008ed9062003115565b6200098084600162001032565b6200099784805190602001206000858534620016e6565b505b505050565b60068054620009ad9062002b04565b80601f0160208091040260200160405190810160405280929190818152602001828054620009db9062002b04565b801562000a2c5780601f1062000a005761010080835404028352916020019162000a2c565b820191906000526020600020905b81548152906001019060200180831162000a0e57829003601f168201915b505050505081565b60606000600262000a5c85805160209182012060009081526005909152604090205460ff1690565b600281111562000a705762000a7062002fef565b0362000a935762000a89848051906020012084620017cf565b9150915062000aab565b62000aa6848051906020012084620018c7565b915091505b9250929050565b600080600262000ad984805160209182012060009081526005909152604090205460ff1690565b600281111562000aed5762000aed62002fef565b0362000b055762000864838051906020012062001940565b62000864838051906020012062001997565b6002546001600160a01b0316331462000b445760405162461bcd60e51b8152600401620008ed90620030e0565b600662000b52828262003196565b5050565b60035460408051630e65e36d60e11b815290516000926001600160a01b031691631ccbc6da9160048083019260209291908290030181865afa15801562000ba1573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019062000bc7919062003262565b905090565b6002546001600160a01b0316331462000bf95760405162461bcd60e51b8152600401620008ed90620030e0565b600062000c1d84805160209182012060009081526005909152604090205460ff1690565b9050600081600281111562000c365762000c3662002fef565b148062000c575750600281600281111562000c555762000c5562002fef565b145b62000c765760405162461bcd60e51b8152600401620008ed9062003115565b600081600281111562000c8d5762000c8d62002fef565b0362000ca05762000ca084600262001032565b6200099784805190602001208484620019e4565b6002546001600160a01b0316331462000ce15760405162461bcd60e51b8152600401620008ed90620030e0565b6002546001600160a01b0316ff5b6000600262000d1584805160209182012060009081526005909152604090205460ff1690565b600281111562000d295762000d2962002fef565b0362000d4a5762000d4283805190602001208362001074565b905062000d65565b600062000d58848462000a34565b5080516020909101209150505b92915050565b6002546001600160a01b0316331462000d985760405162461bcd60e51b8152600401620008ed90620030e0565b600062000dbc85805160209182012060009081526005909152604090205460ff1690565b9050600081600281111562000dd55762000dd562002fef565b148062000df65750600181600281111562000df45762000df462002fef565b145b62000e155760405162461bcd60e51b8152600401620008ed9062003115565b600081600281111562000e2c5762000e2c62002fef565b0362000e3f5762000e3f85600162001032565b62000e55858051906020012085858534620016e6565b5050505050565b6002546000906001600160a01b0316331462000e8c5760405162461bcd60e51b8152600401620008ed90620030e0565b600262000eb083805160209182012060009081526005909152604090205460ff1690565b600281111562000ec45762000ec462002fef565b0362000ede5762000d658280519060200120600062001d6f565b62000d658280519060200120600062001eec565b6002546001600160a01b0316331462000f1f5760405162461bcd60e51b8152600401620008ed90620030e0565b6002546040516001600160a01b03909116904780156108fc02916000818181858888f1935050505015801562000f59573d6000803e3d6000fd5b50565b6002546000906001600160a01b0316331462000f8c5760405162461bcd60e51b8152600401620008ed90620030e0565b600262000fb084805160209182012060009081526005909152604090205460ff1690565b600281111562000fc45762000fc462002fef565b0362000fdd5762000d4283805190602001208362001fb4565b62000ff083805190602001208362002106565b9392505050565b6002546001600160a01b03163314620010245760405162461bcd60e51b8152600401620008ed90620030e0565b620010306000620021f6565b565b81516020808401919091206000908152600590915260409020805482919060ff191660018360028111156200106b576200106b62002fef565b02179055505050565b6000828152600460205260408120548210620010935750600062000d65565b600354600084815260046020526040902080546001600160a01b039092169163d8389dc5919085908110620010cc57620010cc62002a96565b90600052602060002001546040518263ffffffff1660e01b8152600401620010f691815260200190565b602060405180830381865afa15801562001114573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906200113a91906200327c565b67ffffffffffffffff19169392505050565b6002546001600160a01b03163314620011795760405162461bcd60e51b8152600401620008ed90620030e0565b600380546001600160a01b0319166001600160a01b0392909216919091179055565b6000806002620011c285805160209182012060009081526005909152604090205460ff1690565b6002811115620011d657620011d662002fef565b03620011ef5762000a8984805190602001208462002248565b62000aa68480519060200120846200231f565b6002546000906001600160a01b03163314620012325760405162461bcd60e51b8152600401620008ed90620030e0565b60026200125684805160209182012060009081526005909152604090205460ff1690565b60028111156200126a576200126a62002fef565b03620012835762000d4283805190602001208362001d6f565b62000ff083805190602001208362001eec565b6002546001600160a01b03163314620012c35760405162461bcd60e51b8152600401620008ed90620030e0565b6001600160a01b0381166200132a5760405162461bcd60e51b815260206004820152602660248201527f4f776e61626c653a206e6577206f776e657220697320746865207a65726f206160448201526564647265737360d01b6064820152608401620008ed565b62000f5981620021f6565b600060026200135b83805160209182012060009081526005909152604090205460ff1690565b60028111156200136f576200136f62002fef565b03620013935762000d65828051906020012060009081526004602052604090205490565b62000d65828051906020012062002377565b60606000806000620013b78562001940565b9150915080600003620013ff5760005b6040519080825280601f01601f191660200182016040528015620013f2576020820181803683370190505b5095600095509350505050565b6000826001600160401b038111156200141c576200141c62002bc7565b6040519080825280601f01601f19166020018201604052801562001447576020820181803683370190505b5090506000805b83811015620015aa5760008881526004602052604081208054839081106200147a576200147a62002a96565b600091825260208220015460035460405163afd5644d60e01b8152600481018390529193506001600160a01b03169063afd5644d90602401602060405180830381865afa158015620014d0573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190620014f6919062003262565b60035460405163bea94b8b60e01b81529192506001600160a01b03169063bea94b8b90620015319085906001906000908790600401620032a9565b600060405180830381865afa1580156200154f573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f19168201604052620015799190810190620032de565b508060406020868801013e620015908185620030ca565b935050508080620015a1906200335d565b9150506200144e565b50909660019650945050505050565b60606000806000620015cb8562001997565b9150915080600003620015e0576000620013c7565b6000826001600160401b03811115620015fd57620015fd62002bc7565b6040519080825280601f01601f19166020018201604052801562001628576020820181803683370190505b5090506020810160005b83811015620015aa57600088815260208181526040808320848452909152812054906200165f82620023b6565b15620016a157620016708260e01c90565b60008b8152600160209081526040808320878452909152902090915062001699908386620023cb565b5050620016c0565b81620016ad816200247f565b509150620016bc8186620024e5565b5050505b620016cc8185620030ca565b935050508080620016dd906200335d565b91505062001632565b620016f2858562002544565b60ff7f00000000000000000000000000000000000000000000000000000000000000001682111562001759576200173b6200172f8484846200265c565b6001600160a01b031690565b60008681526020818152604080832088845290915290205562000e55565b60008581526001602090815260408083208784528252918290208251601f8601839004830281018301909352848352620017b092909186908690819084018382808284376000920191909152506200271892505050565b6000868152602081815260408083208884529091529020555050505050565b6060600080620017e0858562002248565b50905060018110156200180757505060408051600080825260208201909252915062000aab565b6003546000868152600460205260408120805491926001600160a01b03169163bea94b8b91908890811062001840576200184062002a96565b60009182526020822001546040516001600160e01b031960e085901b16815262001872926001918890600401620032a9565b600060405180830381865afa15801562001890573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f19168201604052620018ba9190810190620032de565b9660019650945050505050565b60008281526020818152604080832084845290915281205460609190620018ee81620023b6565b15620019285760008581526001602090815260408083208784529091528120620019199083620027bd565b93506001925062000aab915050565b80620019348162002859565b93509350505062000aab565b6000806000805b60008062001956878462002248565b9150915080620019685750506200198d565b620019748285620030ca565b93508262001982816200335d565b935050505062001947565b9094909350915050565b6000806000805b600080620019ad87846200231f565b9150915080620019bf5750506200198d565b620019cb8285620030ca565b935082620019d9816200335d565b93505050506200199e565b815160035460408051630e65e36d60e11b815290516000926001600160a01b031691631ccbc6da9160048083019260209291908290030181865afa15801562001a31573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019062001a57919062003262565b905062001a65828262003379565b34101562001aad5760405162461bcd60e51b8152602060048201526014602482015273696e73756666696369656e742062616c616e636560601b6044820152606401620008ed565b60005b828160ff16101562001d67577f000000000000000000000000000000000000000000000000000000000000000063ffffffff16848260ff168151811062001afb5762001afb62002a96565b6020026020010151111562001b4a5760405162461bcd60e51b81526020600482015260146024820152730d2dcecc2d8d2c840c6d0eadcd640d8cadccee8d60631b6044820152606401620008ed565b62001b7586868360ff168151811062001b675762001b6762002a96565b6020026020010151620028ff565b60003342878460ff168151811062001b915762001b9162002a96565b60200260200101518460405160200162001bd294939291906001600160a01b039490941684526020840192909252604083015260ff16606082015260800190565b604051602081830303815290604052805190602001209050600360009054906101000a90046001600160a01b03166001600160a01b0316634581a920848385898760ff168151811062001c295762001c2962002a96565b60200260200101516040518563ffffffff1660e01b815260040162001c649392919092835260ff919091166020830152604082015260600190565b6000604051808303818588803b15801562001c7e57600080fd5b505af115801562001c93573d6000803e3d6000fd5b505050505062001caf8760009081526004602052604090205490565b868360ff168151811062001cc75762001cc762002a96565b6020026020010151101562001d2f578060046000898152602001908152602001600020878460ff168151811062001d025762001d0262002a96565b60200260200101518154811062001d1d5762001d1d62002a96565b60009182526020909120015562001d51565b6000878152600460209081526040822080546001810182559083529120018190555b508062001d5e8162003393565b91505062001ab0565b505050505050565b600082815260046020526040812054811062001dce5760405162461bcd60e51b815260206004820152601760248201527f7468652066696c6520686173206e6f20636f6e74656e740000000000000000006044820152606401620008ed565b60008381526004602052604081205462001deb9060019062002ac2565b90505b82811062001ee457600354600085815260046020526040902080546001600160a01b03909216916395bc267391908690811062001e2f5762001e2f62002a96565b90600052602060002001546040518263ffffffff1660e01b815260040162001e5991815260200190565b600060405180830381600087803b15801562001e7457600080fd5b505af115801562001e89573d6000803e3d6000fd5b505050600085815260046020526040902080549091508062001eaf5762001eaf620033b5565b60019003818190600052602060002001600090559055806000031562001ee4578062001edb81620033cb565b91505062001dee565b509092915050565b60005b6000838152602081815260408083208584529091529020548062001f14575062001fae565b62001f1f81620023b6565b62001f80576000819050806001600160a01b0316632b68b9c66040518163ffffffff1660e01b8152600401600060405180830381600087803b15801562001f6557600080fd5b505af115801562001f7a573d6000803e3d6000fd5b50505050505b6000848152602081815260408083208684529091528120558262001fa4816200335d565b9350505062001eef565b50919050565b600082815260046020526040812054829062001fd39060019062002ac2565b146200202d5760405162461bcd60e51b815260206004820152602260248201527f6f6e6c7920746865206c617374206368756e6b2063616e2062652072656d6f76604482015261195960f21b6064820152608401620008ed565b600354600084815260046020526040902080546001600160a01b03909216916395bc267391908590811062002066576200206662002a96565b90600052602060002001546040518263ffffffff1660e01b81526004016200209091815260200190565b600060405180830381600087803b158015620020ab57600080fd5b505af1158015620020c0573d6000803e3d6000fd5b5050506000848152600460205260409020805490915080620020e657620020e6620033b5565b600190038181906000526020600020016000905590556001905092915050565b600082815260208181526040808320848452909152812054806200212f57600091505062000d65565b6000848152602081905260408120816200214b866001620030ca565b815260200190815260200160002054146200216b57600091505062000d65565b6200217681620023b6565b620021d7576000819050806001600160a01b0316632b68b9c66040518163ffffffff1660e01b8152600401600060405180830381600087803b158015620021bc57600080fd5b505af1158015620021d1573d6000803e3d6000fd5b50505050505b5050600091825260208281526040808420928452919052812055600190565b600280546001600160a01b038381166001600160a01b0319831681179093556040519116919082907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e090600090a35050565b600082815260046020526040812054819083106200226c5750600090508062000aab565b6003546000858152600460205260408120805491926001600160a01b03169163afd5644d919087908110620022a557620022a562002a96565b90600052602060002001546040518263ffffffff1660e01b8152600401620022cf91815260200190565b602060405180830381865afa158015620022ed573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019062002313919062003262565b95600195509350505050565b6000828152602081815260408083208484529091528120548190806200234d57600080925092505062000aab565b6200235881620023b6565b156200236b576000620019198260e01c90565b8062001934816200247f565b6000805b60008381526020818152604080832084845290915290205480620023a0575062000d65565b81620023ac816200335d565b925050506200237b565b600080620023c48360e01c90565b1192915050565b6000806000620023db8562002a02565b808652909350905083601c8411156200247157601c81016000805b6020600162002407601c8a62002ac2565b62002414906020620030ca565b62002420919062002ac2565b6200242c9190620033e5565b8110156200246d57600081815260208b8152604090912054808552925062002456908490620030ca565b92508062002464816200335d565b915050620023f6565b5050505b600192505050935093915050565b6000806001600160a01b0383166200249c57506000928392509050565b60008060405180610160016040528061012681526020016200353e6101269139519050843b915080821015620024d9575060009485945092505050565b62002313818362002ac2565b600080600080620024f6866200247f565b91509150806200250f5760008093509350505062000aab565b600060405180610160016040528061012681526020016200353e6101269139519050828187893c509095600195509350505050565b60008281526020818152604080832084845290915290205480620025e0578115806200259957506000838152602081905260408120816200258760018662002ac2565b81526020019081526020016000205414155b620025e05760405162461bcd60e51b81526020600482015260166024820152751b5d5cdd081c995c1b1858d9481bdc88185c1c195b9960521b6044820152606401620008ed565b620025eb81620023b6565b6200099957806001600160a01b038116156200099757806001600160a01b0316632b68b9c66040518163ffffffff1660e01b8152600401600060405180830381600087803b1580156200263d57600080fd5b505af115801562002652573d6000803e3d6000fd5b5050505050505050565b60008060405180610160016040528061012681526020016200353e61012691398585604051602001620026929392919062003408565b60408051601f1981840301815291905290506000620026b460436020620030ca565b30838201529050620026c9608c6020620030ca565b905030818301525060008382604051620026e39062002a88565b620026ef919062002d9d565b6040518091039082f09050801580156200270d573d6000803e3d6000fd5b509695505050505050565b805160208083015160e083901b911c1790601c811115620027b6576000603c8401815b602060016200274c601c8762002ac2565b62002759906020620030ca565b62002765919062002ac2565b620027719190620033e5565b811015620027b257815192506200278a826020620030ca565b6000828152602089905260409020849055915080620027a9816200335d565b9150506200273b565b5050505b5092915050565b60606000620027cc8362002a1d565b92509050601c811115620027b657603c82016000805b60206001620027f3601c8762002ac2565b62002800906020620030ca565b6200280c919062002ac2565b620028189190620033e5565b811015620027b25760008181526020888152604090912054808552925062002842908490620030ca565b92508062002850816200335d565b915050620027e2565b606060008060006200286b856200247f565b91509150806200287d576000620013c7565b6000826001600160401b038111156200289a576200289a62002bc7565b6040519080825280601f01601f191660200182016040528015620028c5576020820181803683370190505b509050600060405180610160016040528061012681526020016200353e6101269139519050838160208401893c5095600195509350505050565b600082815260046020526040902054811115620029585760405162461bcd60e51b81526020600482015260166024820152751b5d5cdd081c995c1b1858d9481bdc88185c1c195b9960521b6044820152606401620008ed565b60008281526004602052604090205481101562000b5257600354600083815260046020526040902080546001600160a01b03909216916395bc2673919084908110620029a857620029a862002a96565b90600052602060002001546040518263ffffffff1660e01b8152600401620029d291815260200190565b600060405180830381600087803b158015620029ed57600080fd5b505af115801562001d67573d6000803e3d6000fd5b60008062002a108360e01c90565b9360209390931b92915050565b6000606062002a2c8360e01c90565b9150602083901b9250816001600160401b0381111562002a505762002a5062002bc7565b6040519080825280601f01601f19166020018201604052801562002a7b576020820181803683370190505b5060208101939093525091565b61010b806200343383390190565b634e487b7160e01b600052603260045260246000fd5b634e487b7160e01b600052601160045260246000fd5b8181038181111562000d655762000d6562002aac565b6000808585111562002ae957600080fd5b8386111562002af757600080fd5b5050820193919092039150565b600181811c9082168062002b1957607f821691505b60208210810362001fae57634e487b7160e01b600052602260045260246000fd5b828482376000838201600081526000845462002b568162002b04565b6001828116801562002b71576001811462002b875762002bb8565b60ff198416865282151583028601945062002bb8565b8860005260208060002060005b8581101562002baf5781548982015290840190820162002b94565b50505082860194505b50929998505050505050505050565b634e487b7160e01b600052604160045260246000fd5b604051601f8201601f191681016001600160401b038111828210171562002c085762002c0862002bc7565b604052919050565b60006001600160401b0382111562002c2c5762002c2c62002bc7565b50601f01601f191660200190565b600082601f83011262002c4c57600080fd5b813562002c6362002c5d8262002c10565b62002bdd565b81815284602083860101111562002c7957600080fd5b816020850160208301376000918101602001919091529392505050565b60008083601f84011262002ca957600080fd5b5081356001600160401b0381111562002cc157600080fd5b60208301915083602082850101111562000aab57600080fd5b60008060006040848603121562002cf057600080fd5b83356001600160401b038082111562002d0857600080fd5b62002d168783880162002c3a565b9450602086013591508082111562002d2d57600080fd5b5062002d3c8682870162002c96565b9497909650939450505050565b60005b8381101562002d6657818101518382015260200162002d4c565b50506000910152565b6000815180845262002d8981602086016020860162002d49565b601f01601f19169290920160200192915050565b60208152600062000ff0602083018462002d6f565b6000806040838503121562002dc657600080fd5b82356001600160401b0381111562002ddd57600080fd5b62002deb8582860162002c3a565b95602094909401359450505050565b60408152600062002e0f604083018562002d6f565b905082151560208301529392505050565b60006020828403121562002e3357600080fd5b81356001600160401b0381111562002e4a57600080fd5b62002e588482850162002c3a565b949350505050565b600082601f83011262002e7257600080fd5b813560206001600160401b0382111562002e905762002e9062002bc7565b8160051b62002ea182820162002bdd565b928352848101820192828101908785111562002ebc57600080fd5b83870192505b8483101562002edd5782358252918301919083019062002ec2565b979650505050505050565b60008060006060848603121562002efe57600080fd5b83356001600160401b038082111562002f1657600080fd5b62002f248783880162002c3a565b9450602086013591508082111562002f3b57600080fd5b62002f498783880162002e60565b9350604086013591508082111562002f6057600080fd5b5062002f6f8682870162002e60565b9150509250925092565b6000806000806060858703121562002f9057600080fd5b84356001600160401b038082111562002fa857600080fd5b62002fb68883890162002c3a565b955060208701359450604087013591508082111562002fd457600080fd5b5062002fe38782880162002c96565b95989497509550505050565b634e487b7160e01b600052602160045260246000fd5b60208101600383106200301c576200301c62002fef565b91905290565b600080604083850312156200303657600080fd5b82356001600160401b038111156200304d57600080fd5b6200305b8582860162002c3a565b9250506020830135600381106200307157600080fd5b809150509250929050565b600080604083850312156200309057600080fd5b50508035926020909101359150565b600060208284031215620030b257600080fd5b81356001600160a01b038116811462000ff057600080fd5b8082018082111562000d655762000d6562002aac565b6020808252818101527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604082015260600190565b60208082526018908201527f496e76616c69642066696c652075706c6f6164206d6f64650000000000000000604082015260600190565b601f8211156200099957600081815260208120601f850160051c81016020861015620031755750805b601f850160051c820191505b8181101562001d675782815560010162003181565b81516001600160401b03811115620031b257620031b262002bc7565b620031ca81620031c3845462002b04565b846200314c565b602080601f831160018114620032025760008415620031e95750858301515b600019600386901b1c1916600185901b17855562001d67565b600085815260208120601f198616915b82811015620032335788860151825594840194600190910190840162003212565b5085821015620032525787850151600019600388901b60f8161c191681555b5050505050600190811b01905550565b6000602082840312156200327557600080fd5b5051919050565b6000602082840312156200328f57600080fd5b815167ffffffffffffffff198116811462000ff057600080fd5b8481526080810160028510620032c357620032c362002fef565b84602083015283604083015282606083015295945050505050565b600060208284031215620032f157600080fd5b81516001600160401b038111156200330857600080fd5b8201601f810184136200331a57600080fd5b80516200332b62002c5d8262002c10565b8181528560208385010111156200334157600080fd5b6200335482602083016020860162002d49565b95945050505050565b60006001820162003372576200337262002aac565b5060010190565b808202811582820484141762000d655762000d6562002aac565b600060ff821660ff8103620033ac57620033ac62002aac565b60010192915050565b634e487b7160e01b600052603160045260246000fd5b600081620033dd57620033dd62002aac565b506000190190565b6000826200340357634e487b7160e01b600052601260045260246000fd5b500490565b600084516200341c81846020890162002d49565b820183858237600093019283525090939250505056fe608060405260405161010b38038061010b83398101604081905261002291610041565b80518060208301f35b634e487b7160e01b600052604160045260246000fd5b6000602080838503121561005457600080fd5b82516001600160401b038082111561006b57600080fd5b818501915085601f83011261007f57600080fd5b8151818111156100915761009161002b565b604051601f8201601f19908116603f011681019083821181831017156100b9576100b961002b565b8160405282815288868487010111156100d157600080fd5b600093505b828410156100f357848401860151818501870152928501926100d6565b60008684830101528096505050505050509291505056fe6080604052348015600f57600080fd5b506004361060325760003560e01c80632b68b9c61460375780638da5cb5b14603f575b600080fd5b603d6081565b005b60657f000000000000000000000000000000000000000000000000000000000000000081565b6040516001600160a01b03909116815260200160405180910390f35b336001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000161460ed5760405162461bcd60e51b815260206004820152600e60248201526d3737ba10333937b69037bbb732b960911b604482015260640160405180910390fd5b33fffea2646970667358221220fc66c9afb7cb2f6209ae28167cf26c6c06f86a82cbe3c56de99027979389a1be64736f6c63430008070033a26469706673582212200189ace7bc31b5d309eea07616c17a65a435f32c7f5710b0571cb3de4ed32b1c64736f6c63430008120033';
        const factory = new ethers.ContractFactory(flatDirectoryBlobAbi, contractByteCode, this.#wallet);
        let contract = await factory.deploy(0, 31 * 4096, ETH_STORAGE, {
            gasLimit: 8000000
        });
        contract = await contract.waitForDeployment();
        if (contract) {
            console.log(`FlatDirectory Address: ${await contract.getAddress()}`);
            this.#contractAddr = await contract.getAddress();
        } else {
            console.error(`ERROR: deploy flat directory failed!`);
        }
    }

    async setDefaultFile(filename) {
        if (!this.#contractAddr) {
            console.error(`ERROR: flat directory not deployed!`);
            return;
        }

        const fileContract = new ethers.Contract(this.#contractAddr, flatDirectoryBlobAbi, this.#wallet);
        const defaultFile = '0x' + Buffer.from(filename, 'utf8').toString('hex');
        const tx = await fileContract.setDefault(defaultFile);
        const txReceipt = await tx.wait();
        if (txReceipt.status) {
            console.log(`Set succeeds`);
        } else {
            console.error(`ERROR: set failed!`);
        }
    }

    async upload(filePath) {
        if (!this.#contractAddr) {
            console.error(`ERROR: flat directory not deployed!`);
            return;
        }
        const fileStat = fs.statSync(filePath);
        if (!fileStat.isFile()) {
            console.error(`ERROR: only upload file!`);
            return;
        }

        const fileContract = new ethers.Contract(this.#contractAddr, flatDirectoryBlobAbi, this.#wallet);
        const cost = await fileContract.upfrontPayment();

        const content = fs.readFileSync(filePath);
        const blobs = EncodeBlobs(content);
        const blobLength = blobs.length;
        const fileSize = fileStat.size;
        const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);
        const hexName = stringToHex(fileName);

        let successIndex = 0;
        for (let i = 0; i < blobLength; i += MAX_BLOB_COUNT) {
            const blobArr = [];
            const indexArr = [];
            const lenArr = [];
            let max = i + MAX_BLOB_COUNT > blobLength ? blobLength : i + MAX_BLOB_COUNT;
            for (let j = i; j < max; j++) {
                blobArr.push(blobs[j]);
                indexArr.push(j);
                if (j === blobLength - 1) {
                    lenArr.push(fileSize - BLOB_FILE_SIZE * (blobLength - 1));
                } else {
                    lenArr.push(BLOB_FILE_SIZE);
                }
            }

            // check
            let hasChange = false;
            for (let j = 0; j < blobArr.length; j++) {
                const dataHash = await fileContract.getChunkHash(hexName, indexArr[j]);
                const localHash = this.#blobUploader.getBlobHash(blobArr[j]);
                if (dataHash !== localHash) {
                    hasChange = true;
                    break;
                }
            }
            if (!hasChange) {
                successIndex += indexArr.length;
                console.log(`File ${fileName} chunkId: ${indexArr}: The data is not changed.`);
                continue;
            }

            // send
            let success = false;
            try {
                const value = cost * BigInt(blobArr.length);
                const tx = await fileContract.writeChunks.populateTransaction(hexName, indexArr, lenArr, {
                    value
                });
                const hash = await this.#blobUploader.sendTx(tx, blobArr);
                console.log(`Transaction Id: ${hash}`);
                const txReceipt = await this.#blobUploader.getTxReceipt(hash);
                if (txReceipt && txReceipt.status) {
                    success = true;
                    successIndex += indexArr.length;
                    console.log(`File ${fileName} chunkId: ${indexArr} uploaded!`);
                }
            } catch (e) {
                console.log('Error:' + e);
            }
            if (!success) {
                break;
            }
        }
        return {
            totalBlobCount: blobLength,
            successBlobIndex: successIndex,
        }
    }
}

module.exports = {
    EthStorage
}
