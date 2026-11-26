; benchmark generated from python API
(set-info :status unknown)
(declare-fun logical_size () (_ BitVec 32))
(declare-fun addr () (_ BitVec 32))
(declare-fun base () (_ BitVec 32))
(declare-fun query () (_ BitVec 32))
(declare-fun physical () (Array (_ BitVec 32) (_ BitVec 8)))
(declare-fun logical () (Array (_ BitVec 32) (_ BitVec 8)))
(declare-fun value () (_ BitVec 32))
(assert
 (let ((?x15 ((_ zero_extend 32) logical_size)))
 (bvsle (bvadd ((_ zero_extend 32) addr) (_ bv2 64)) ?x15)))
(assert
 (bvsle (bvadd ((_ zero_extend 32) base) ((_ zero_extend 32) logical_size)) (_ bv4294967296 64)))
(assert
 (bvult query logical_size))
(assert
 (= (select logical query) (select physical (bvadd base query))))
(assert
 (let ((?x90 (bvadd base query)))
(let ((?x35 ((_ extract 15 8) value)))
(let ((?x24 (bvadd base addr)))
(let ((?x16 (bvadd ?x24 (_ bv1 32))))
(let ((?x36 (store (store physical (bvadd ?x24 (_ bv0 32)) ((_ extract 7 0) value)) ?x16 ?x35)))
(let ((?x212 ((_ extract 7 0) (bvudiv value (_ bv256 32)))))
(let ((?x13 (bvadd addr (_ bv1 32))))
(let ((?x63 (store (store logical (bvadd addr (_ bv0 32)) ((_ extract 7 0) (bvudiv value (_ bv1 32)))) ?x13 ?x212)))
(and (distinct (select ?x63 query) (select ?x36 ?x90)) true))))))))))
(check-sat)
